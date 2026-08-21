use crate::{AppState, SoneError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::collections::HashSet;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInvocation {
    pub urls: Vec<String>,
    pub output: String,
    pub cover_url: Option<String>,
}

fn dependency_error(message: impl Into<String>) -> SoneError {
    SoneError::Io(format!(
        "tiddl-headless dependency error: {}",
        message.into()
    ))
}

fn tiddl_executable() -> PathBuf {
    if let Some(path) = std::env::var_os("PATH") {
        for directory in std::env::split_paths(&path) {
            let candidate = directory.join("tiddl");
            if candidate.is_file() {
                return candidate;
            }
        }
    }

    // Desktop launchers commonly inherit systemd's minimal PATH, which omits
    // the standard user-local location used by pipx and similar installers.
    if let Some(home) = std::env::var_os("HOME") {
        let candidate = PathBuf::from(home).join(".local/bin/tiddl");
        if candidate.is_file() {
            return candidate;
        }
    }

    PathBuf::from("tiddl")
}

#[tauri::command]
pub async fn check_tiddl() -> Result<(), SoneError> {
    let output = Command::new(tiddl_executable())
        .args(["download", "--events", "jsonl", "url", "--help"])
        .output()
        .await
        .map_err(|error| {
            dependency_error(format!(
                "could not run `tiddl`: {error}. Install tiddl-headless and run `tiddl auth login`."
            ))
        })?;

    if !output.status.success() {
        return Err(dependency_error(
            "`tiddl download --events jsonl` is unavailable. Install a compatible tiddl-headless version.",
        ));
    }
    Ok(())
}

fn emit(app: &AppHandle, event: &str, payload: Value) {
    if let Err(error) = app.emit(event, payload) {
        log::warn!("Failed to emit {event}: {error}");
    }
}

fn frontend_event_name(event: &str) -> String {
    format!("download:{}", event.replace('_', "-"))
}

fn emit_failure(app: &AppHandle, message: &str) {
    emit(
        app,
        "download:job-failed",
        json!({ "error": { "code": "incompatible_downloader", "message": message } }),
    );
    emit(app, "download:job-completed", json!({ "success": false }));
}

enum InvocationResult {
    Failed(String),
    Cancelled,
}

async fn stop_process_group(child: &mut tokio::process::Child) {
    let Some(pid) = child.id() else {
        return;
    };

    // tiddl may invoke ffmpeg, so terminate the dedicated process group rather
    // than leaving a converter running after its parent is gone.
    unsafe {
        libc::kill(-(pid as i32), libc::SIGINT);
    }
    if timeout(Duration::from_secs(2), child.wait()).await.is_err() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
        let _ = child.wait().await;
    }
}

async fn kill_process_group(child: &mut tokio::process::Child) {
    if let Some(pid) = child.id() {
        unsafe {
            libc::kill(-(pid as i32), libc::SIGKILL);
        }
    }
    let _ = child.wait().await;
}

async fn run_invocation(
    app: &AppHandle,
    destination: &str,
    quality: &str,
    group: DownloadInvocation,
    cancellation: &CancellationToken,
) -> Result<Vec<PathBuf>, InvocationResult> {
    if group.urls.is_empty() {
        return Ok(Vec::new());
    }
    if cancellation.is_cancelled() {
        return Err(InvocationResult::Cancelled);
    }

    log::debug!("Starting tiddl download invocation for {} resource(s)", group.urls.len());
    let mut command = Command::new(tiddl_executable());
    command
        .args([
            "download",
            "--events",
            "jsonl",
            "--path",
            destination,
            "--scan-path",
            destination,
            "--output",
            &group.output,
        ])
        .arg("--track-quality")
        .arg(quality)
        .arg("url")
        .args(&group.urls)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    unsafe {
        command.pre_exec(|| {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| InvocationResult::Failed(format!("Could not start tiddl: {error}")))?;
    log::debug!("tiddl download invocation started");
    let stdout = child
        .stdout
        .take()
        .ok_or_else(|| InvocationResult::Failed("tiddl stdout was not available".to_string()))?;
    let stderr = child
        .stderr
        .take()
        .ok_or_else(|| InvocationResult::Failed("tiddl stderr was not available".to_string()))?;
    let stderr_task = tokio::spawn(async move {
        let mut lines = BufReader::new(stderr).lines();
        let mut tail = Vec::new();
        while let Ok(Some(line)) = lines.next_line().await {
            // Diagnostics are deliberately not emitted: they can contain sensitive URLs.
            if !line.is_empty() {
                tail.push(line);
                if tail.len() > 3 {
                    tail.remove(0);
                }
            }
        }
        tail
    });

    let mut lines = BufReader::new(stdout).lines();
    let mut completed = false;
    let mut output_directories = HashSet::new();
    loop {
        let line = tokio::select! {
            _ = cancellation.cancelled() => {
                stop_process_group(&mut child).await;
                let _ = stderr_task.await;
                return Err(InvocationResult::Cancelled);
            }
            result = lines.next_line() => result.map_err(|error| InvocationResult::Failed(error.to_string()))?,
        };
        let Some(line) = line else {
            break;
        };
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                kill_process_group(&mut child).await;
                return Err(InvocationResult::Failed(
                    "tiddl emitted malformed JSONL. Install a compatible tiddl-headless version."
                        .to_string(),
                ));
            }
        };
        if value.get("schema_version").and_then(Value::as_u64) != Some(1) {
            kill_process_group(&mut child).await;
            return Err(InvocationResult::Failed("tiddl emitted an unsupported event schema. Install a compatible tiddl-headless version.".to_string()));
        }
        let Some(event) = value.get("event").and_then(Value::as_str) else {
            kill_process_group(&mut child).await;
            return Err(InvocationResult::Failed("tiddl emitted an event without a name. Install a compatible tiddl-headless version.".to_string()));
        };
        match event {
            "job_started" | "item_discovered" | "item_started" | "item_progress"
            | "item_completed" | "item_skipped" | "item_failed" | "job_failed" => {
                if matches!(event, "item_completed" | "item_skipped") {
                    if let Some(output_path) = value.get("output_path").and_then(Value::as_str) {
                        log::debug!("tiddl {event}: {output_path}");
                        let output_path = Path::new(output_path);
                        let output_path = if output_path.is_absolute() {
                            output_path.to_path_buf()
                        } else {
                            Path::new(destination).join(output_path)
                        };
                        if let Some(parent) = output_path.parent() {
                            output_directories.insert(parent.to_path_buf());
                        }
                    }
                }
                emit(app, &frontend_event_name(event), value.clone());
            }
            "job_completed" => {
                completed = value.get("success").and_then(Value::as_bool) == Some(true);
            }
            _ => {
                kill_process_group(&mut child).await;
                return Err(InvocationResult::Failed(
                    "tiddl emitted an unknown event. Install a compatible tiddl-headless version."
                        .to_string(),
                ));
            }
        }
    }
    if cancellation.is_cancelled() {
        return Err(InvocationResult::Cancelled);
    }
    let status = child.wait().await.map_err(|error| InvocationResult::Failed(error.to_string()))?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !completed {
        return Err(InvocationResult::Failed(if stderr_tail.is_empty() {
            "tiddl exited without a job_completed event.".to_string()
        } else {
            "tiddl exited without completing the job. Check that it is authenticated with `tiddl auth login`.".to_string()
        }));
    }
    if !status.success() {
        return Err(InvocationResult::Failed("tiddl reported that the download job failed.".to_string()));
    }
    Ok(output_directories.into_iter().collect())
}

async fn save_album_cover(state: &AppState, cover_url: &str, directories: Vec<PathBuf>) -> Result<(), String> {
    if directories.is_empty() {
        return Ok(());
    }
    let http_client = state.tidal_client.lock().await.raw_client().clone();
    let response = http_client
        .get(cover_url)
        .send()
        .await
        .map_err(|error| format!("could not fetch album cover: {error}"))?
        .error_for_status()
        .map_err(|error| format!("could not fetch album cover: {error}"))?;
    let bytes = response
        .bytes()
        .await
        .map_err(|error| format!("could not read album cover: {error}"))?;

    for directory in directories {
        tokio::fs::write(directory.join("cover.jpg"), &bytes)
            .await
            .map_err(|error| format!("could not save cover.jpg: {error}"))?;
        tokio::fs::write(directory.join("folder.jpg"), &bytes)
            .await
            .map_err(|error| format!("could not save folder.jpg: {error}"))?;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::frontend_event_name;

    #[test]
    fn converts_downloader_event_names_to_frontend_event_names() {
        assert_eq!(
            frontend_event_name("item_discovered"),
            "download:item-discovered"
        );
        assert_eq!(frontend_event_name("job_failed"), "download:job-failed");
    }
}

#[tauri::command]
pub async fn start_download_job(
    app: AppHandle,
    state: State<'_, AppState>,
    destination: String,
    groups: Vec<DownloadInvocation>,
) -> Result<(), SoneError> {
    log::debug!("Received download job with {} invocation group(s)", groups.len());
    if destination.trim().is_empty() || groups.is_empty() {
        return Err(dependency_error(
            "A destination and at least one queued resource are required.",
        ));
    }
    if state.download_active.swap(true, Ordering::AcqRel) {
        return Err(dependency_error("A download job is already running."));
    }
    let cancellation = CancellationToken::new();
    *state.download_cancellation.lock().unwrap() = Some(cancellation.clone());
    let quality = state
        .load_settings()
        .map(|settings| settings.download_quality)
        .filter(|quality| matches!(quality.as_str(), "low" | "normal" | "high" | "max"))
        .unwrap_or_else(|| "max".to_string());
    let result: Result<(), InvocationResult> = async {
        for group in groups {
            let save_cover = state
                .load_settings()
                .map(|settings| settings.download_album_cover)
                .unwrap_or(false);
            let cover_url = group.cover_url.clone();
            let directories = run_invocation(&app, &destination, &quality, group, &cancellation).await?;
            if save_cover {
                if let Some(cover_url) = cover_url {
                    if let Err(error) = save_album_cover(&state, &cover_url, directories).await {
                        log::warn!("Could not save downloaded album cover: {error}");
                    }
                }
            }
        }
        emit(&app, "download:job-completed", json!({ "success": true }));
        Ok(())
    }
    .await;
    state.download_active.store(false, Ordering::Release);
    *state.download_cancellation.lock().unwrap() = None;

    match result {
        Ok(()) => {}
        Err(InvocationResult::Cancelled) => {
            emit(&app, "download:job-cancelled", json!({}));
        }
        Err(InvocationResult::Failed(message)) => {
            log::warn!("tiddl download job failed: {message}");
            emit_failure(&app, &message);
            return Err(dependency_error(message));
        }
    }
    log::debug!("tiddl download job completed successfully");
    Ok(())
}

#[tauri::command]
pub async fn stop_download_job(state: State<'_, AppState>) -> Result<(), SoneError> {
    if let Some(cancellation) = state.download_cancellation.lock().unwrap().as_ref() {
        cancellation.cancel();
    }
    Ok(())
}
