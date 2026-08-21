use crate::{AppState, SoneError};
use serde::Deserialize;
use serde_json::{json, Value};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, Manager, State};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInvocation {
    pub urls: Vec<String>,
    pub output: String,
}

fn dependency_error(message: impl Into<String>) -> SoneError {
    SoneError::Io(format!(
        "tiddl-headless dependency error: {}",
        message.into()
    ))
}

#[tauri::command]
pub async fn check_tiddl() -> Result<(), SoneError> {
    let output = Command::new("tiddl")
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

fn emit_failure(app: &AppHandle, message: &str) {
    emit(
        app,
        "download:job-failed",
        json!({ "error": { "code": "incompatible_downloader", "message": message } }),
    );
    emit(app, "download:job-completed", json!({ "success": false }));
}

async fn run_invocation(
    app: &AppHandle,
    destination: &str,
    group: DownloadInvocation,
) -> Result<(), String> {
    if group.urls.is_empty() {
        return Ok(());
    }

    let mut command = Command::new("tiddl");
    command
        .args([
            "download",
            "--events",
            "jsonl",
            "--path",
            destination,
            "--output",
            &group.output,
            "url",
        ])
        .args(&group.urls)
        .stdout(std::process::Stdio::piped())
        .stderr(std::process::Stdio::piped());
    let mut child = command
        .spawn()
        .map_err(|error| format!("Could not start tiddl: {error}"))?;
    let stdout = child
        .stdout
        .take()
        .ok_or("tiddl stdout was not available")?;
    let stderr = child
        .stderr
        .take()
        .ok_or("tiddl stderr was not available")?;
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
    while let Some(line) = lines.next_line().await.map_err(|error| error.to_string())? {
        let value: Value = match serde_json::from_str(&line) {
            Ok(value) => value,
            Err(_) => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(
                    "tiddl emitted malformed JSONL. Install a compatible tiddl-headless version."
                        .to_string(),
                );
            }
        };
        if value.get("schema_version").and_then(Value::as_u64) != Some(1) {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("tiddl emitted an unsupported event schema. Install a compatible tiddl-headless version.".to_string());
        }
        let Some(event) = value.get("event").and_then(Value::as_str) else {
            let _ = child.kill().await;
            let _ = child.wait().await;
            return Err("tiddl emitted an event without a name. Install a compatible tiddl-headless version.".to_string());
        };
        match event {
            "job_started" | "item_discovered" | "item_started" | "item_progress"
            | "item_completed" | "item_skipped" | "item_failed" | "job_failed" => {
                emit(app, &format!("download:{event}"), value.clone());
            }
            "job_completed" => {
                completed = value.get("success").and_then(Value::as_bool) == Some(true);
            }
            _ => {
                let _ = child.kill().await;
                let _ = child.wait().await;
                return Err(
                    "tiddl emitted an unknown event. Install a compatible tiddl-headless version."
                        .to_string(),
                );
            }
        }
    }
    let status = child.wait().await.map_err(|error| error.to_string())?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !completed {
        return Err(if stderr_tail.is_empty() {
            "tiddl exited without a job_completed event.".to_string()
        } else {
            "tiddl exited without completing the job. Check that it is authenticated with `tiddl auth login`.".to_string()
        });
    }
    if !status.success() {
        return Err("tiddl reported that the download job failed.".to_string());
    }
    Ok(())
}

#[tauri::command]
pub async fn start_download_job(
    app: AppHandle,
    state: State<'_, AppState>,
    destination: String,
    groups: Vec<DownloadInvocation>,
) -> Result<(), SoneError> {
    if destination.trim().is_empty() || groups.is_empty() {
        return Err(dependency_error(
            "A destination and at least one queued resource are required.",
        ));
    }
    if state.download_active.swap(true, Ordering::AcqRel) {
        return Err(dependency_error("A download job is already running."));
    }
    tauri::async_runtime::spawn(async move {
        for group in groups {
            if let Err(message) = run_invocation(&app, &destination, group).await {
                emit_failure(&app, &message);
                app.state::<AppState>()
                    .download_active
                    .store(false, Ordering::Release);
                return;
            }
        }
        emit(&app, "download:job-completed", json!({ "success": true }));
        app.state::<AppState>()
            .download_active
            .store(false, Ordering::Release);
    });
    Ok(())
}
