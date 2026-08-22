use crate::commands::auth::resolve_credentials;
use crate::tidal_api::AuthTokens;
use crate::{now_secs, AppState, ProxyType, SoneError};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::collections::HashSet;
use std::ffi::OsString;
use std::os::fd::AsRawFd;
use std::os::unix::net::UnixStream as StdUnixStream;
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;
use tauri::{AppHandle, Emitter, State};
use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};
use tokio::process::Command;
use tokio::time::{timeout, Duration};
use tokio_util::sync::CancellationToken;

const BUNDLED_TIDDL_EXECUTABLE: &str = "/usr/lib/sone/sone-tiddl/sone-tiddl";
const SONE_AUTH_FD: libc::c_int = 3;

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct DownloadInvocation {
    pub urls: Vec<String>,
    pub output: String,
    pub cover_url: Option<String>,
}

fn dependency_error(message: impl Into<String>) -> SoneError {
    SoneError::Io(format!("Sone download helper error: {}", message.into()))
}

fn tiddl_executable_from(override_path: Option<OsString>) -> PathBuf {
    override_path
        .map(PathBuf::from)
        .unwrap_or_else(|| PathBuf::from(BUNDLED_TIDDL_EXECUTABLE))
}

fn tiddl_executable() -> PathBuf {
    tiddl_executable_from(std::env::var_os("SONE_TIDDL_EXECUTABLE"))
}

#[tauri::command]
pub async fn check_tiddl() -> Result<(), SoneError> {
    let output = Command::new(tiddl_executable())
        .arg("--capabilities")
        .output()
        .await
        .map_err(|error| {
            dependency_error(format!(
                "could not run the bundled helper: {error}. Reinstall Sone."
            ))
        })?;

    if !output.status.success() || output.stdout != b"sone-tiddl jsonl-v1\n" {
        return Err(dependency_error(
            "the bundled helper is missing or incompatible. Reinstall Sone.",
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

#[derive(Serialize)]
struct HelperCredentials {
    access_token: String,
    refresh_token: String,
    user_id: String,
    country_code: String,
    client_id: String,
    client_secret: String,
    expires_at: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    proxy_url: Option<String>,
}

#[derive(Serialize)]
struct CredentialMessage {
    r#type: &'static str,
    credentials: HelperCredentials,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct RefreshedCredentials {
    access_token: String,
    refresh_token: String,
    user_id: String,
    country_code: String,
    client_id: String,
    client_secret: String,
    #[serde(default)]
    expires_at: u64,
    #[serde(default)]
    proxy_url: Option<String>,
}

#[derive(Deserialize)]
#[serde(deny_unknown_fields)]
struct CredentialRefreshMessage {
    r#type: String,
    credentials: RefreshedCredentials,
}

fn proxy_url(state: &AppState) -> Option<String> {
    let proxy = state.load_settings()?.proxy;
    if !proxy.enabled || proxy.host.is_empty() || proxy.port == 0 {
        return None;
    }
    let scheme = match proxy.proxy_type {
        ProxyType::Http => "http",
        ProxyType::Socks5 => "socks5",
    };
    Some(format!("{scheme}://{}:{}", proxy.host, proxy.port))
}

async fn helper_credentials(state: &AppState) -> Result<HelperCredentials, InvocationResult> {
    let settings = state.load_settings().ok_or_else(|| {
        InvocationResult::Failed("Sign in to TIDAL before downloading.".to_string())
    })?;
    let (client_id, client_secret) = resolve_credentials(&settings);
    let mut client = state.tidal_client.lock().await;
    let tokens = client.refresh_token().await.map_err(|_| {
        InvocationResult::Failed("Could not refresh the active Sone TIDAL session.".to_string())
    })?;

    Ok(HelperCredentials {
        access_token: tokens.access_token,
        refresh_token: tokens.refresh_token,
        user_id: tokens.user_id.map(|id| id.to_string()).unwrap_or_default(),
        country_code: client.country_code.clone(),
        client_id,
        client_secret,
        expires_at: now_secs().saturating_add(tokens.expires_in),
        proxy_url: proxy_url(state),
    })
}

fn parse_refresh(line: &str) -> Result<RefreshedCredentials, InvocationResult> {
    let message: CredentialRefreshMessage = serde_json::from_str(line).map_err(|_| {
        InvocationResult::Failed("The bundled helper returned an invalid credential update.".to_string())
    })?;
    if message.r#type != "credentials_refreshed" {
        Err(InvocationResult::Failed(
            "The bundled helper returned an unexpected credential update.".to_string(),
        ))
    } else {
        Ok(message.credentials)
    }
}

fn parse_download_event(line: &str) -> Result<(Value, String), InvocationResult> {
    let value: Value = serde_json::from_str(line).map_err(|_| {
        InvocationResult::Failed(
            "The bundled helper emitted malformed download events. Reinstall Sone.".to_string(),
        )
    })?;
    if value.get("schema_version").and_then(Value::as_u64) != Some(1) {
        return Err(InvocationResult::Failed(
            "The bundled helper emitted an unsupported download event schema. Reinstall Sone."
                .to_string(),
        ));
    }
    let event = value
        .get("event")
        .and_then(Value::as_str)
        .ok_or_else(|| {
            InvocationResult::Failed(
                "The bundled helper emitted a download event without a name. Reinstall Sone."
                    .to_string(),
            )
        })?
        .to_string();
    if !matches!(
        event.as_str(),
        "job_started"
            | "item_discovered"
            | "item_started"
            | "item_progress"
            | "item_completed"
            | "item_skipped"
            | "item_failed"
            | "job_failed"
            | "job_completed"
    ) {
        return Err(InvocationResult::Failed(
            "The bundled helper emitted an unknown download event. Reinstall Sone.".to_string(),
        ));
    }
    Ok((value, event))
}

async fn persist_refresh(state: &AppState, line: &str) -> Result<(), InvocationResult> {
    let credentials = parse_refresh(line)?;
    // These immutable connection fields are part of the private protocol but
    // only Sone's persisted tokens may be changed by the helper.
    let _ = (
        &credentials.country_code,
        &credentials.client_id,
        &credentials.client_secret,
        &credentials.proxy_url,
    );
    let expires_in = credentials.expires_at.saturating_sub(now_secs());
    let tokens = AuthTokens {
        access_token: credentials.access_token,
        refresh_token: credentials.refresh_token,
        expires_in,
        token_type: "Bearer".to_string(),
        user_id: credentials.user_id.parse().ok(),
    };
    state.tidal_client.lock().await.tokens = Some(tokens.clone());
    let mut settings = state.load_settings().unwrap_or_default();
    settings.auth_tokens = Some(tokens);
    state.save_settings(&settings).map_err(|_| {
        InvocationResult::Failed("Could not save refreshed Sone TIDAL credentials.".to_string())
    })
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
    state: &AppState,
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

    let credentials = helper_credentials(state).await?;
    let credential_message = serde_json::to_vec(&CredentialMessage {
        r#type: "credentials",
        credentials,
    })
    .map_err(|_| InvocationResult::Failed("Could not prepare Sone authentication.".to_string()))?;
    let (parent_auth, child_auth) = StdUnixStream::pair()
        .map_err(|error| InvocationResult::Failed(format!("Could not create Sone authentication channel: {error}")))?;
    parent_auth
        .set_nonblocking(true)
        .map_err(|error| InvocationResult::Failed(format!("Could not configure Sone authentication channel: {error}")))?;
    let child_auth_fd = child_auth.as_raw_fd();

    log::debug!("Starting Sone download invocation for {} resource(s)", group.urls.len());
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
        command.pre_exec(move || {
            if libc::setsid() == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::dup2(child_auth_fd, SONE_AUTH_FD) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            if libc::fcntl(SONE_AUTH_FD, libc::F_SETFD, 0) == -1 {
                return Err(std::io::Error::last_os_error());
            }
            Ok(())
        });
    }
    let mut child = command
        .spawn()
        .map_err(|error| InvocationResult::Failed(format!("Could not start the bundled helper: {error}")))?;
    drop(child_auth);
    let auth_stream = match tokio::net::UnixStream::from_std(parent_auth) {
        Ok(stream) => stream,
        Err(error) => {
            kill_process_group(&mut child).await;
            return Err(InvocationResult::Failed(format!(
                "Could not open Sone authentication channel: {error}"
            )));
        }
    };
    let (auth_reader, mut auth_writer) = auth_stream.into_split();
    if let Err(error) = auth_writer.write_all(&credential_message).await {
        kill_process_group(&mut child).await;
        return Err(InvocationResult::Failed(format!(
            "Could not send Sone authentication: {error}"
        )));
    }
    if let Err(error) = auth_writer.write_all(b"\n").await {
        kill_process_group(&mut child).await;
        return Err(InvocationResult::Failed(format!(
            "Could not send Sone authentication: {error}"
        )));
    }
    drop(auth_writer);
    log::debug!("Sone download invocation started");
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
    let mut auth_lines = BufReader::new(auth_reader).lines();
    let mut auth_open = true;
    let mut completed = false;
    let mut output_directories = HashSet::new();
    loop {
        let line = tokio::select! {
            _ = cancellation.cancelled() => {
                stop_process_group(&mut child).await;
                let _ = stderr_task.await;
                return Err(InvocationResult::Cancelled);
            }
            refresh = auth_lines.next_line(), if auth_open => match refresh {
                Ok(Some(refresh)) => {
                    if let Err(error) = persist_refresh(state, &refresh).await {
                        kill_process_group(&mut child).await;
                        let _ = stderr_task.await;
                        return Err(error);
                    }
                    continue;
                }
                Ok(None) => {
                    auth_open = false;
                    continue;
                }
                Err(error) => {
                    kill_process_group(&mut child).await;
                    let _ = stderr_task.await;
                    return Err(InvocationResult::Failed(format!("Could not receive Sone credential update: {error}")));
                }
            },
            result = lines.next_line() => match result {
                Ok(line) => line,
                Err(error) => {
                    kill_process_group(&mut child).await;
                    let _ = stderr_task.await;
                    return Err(InvocationResult::Failed(error.to_string()));
                }
            },
        };
        let Some(line) = line else {
            break;
        };
        let (value, event) = match parse_download_event(&line) {
            Ok(event) => event,
            Err(error) => {
                kill_process_group(&mut child).await;
                return Err(error);
            }
        };
        match event.as_str() {
            "job_started" | "item_discovered" | "item_started" | "item_progress"
            | "item_completed" | "item_skipped" | "item_failed" | "job_failed" => {
                if matches!(event.as_str(), "item_completed" | "item_skipped") {
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
                emit(app, &frontend_event_name(&event), value.clone());
            }
            "job_completed" => {
                completed = value.get("success").and_then(Value::as_bool) == Some(true);
            }
            _ => unreachable!("validated download event"),
        }
    }
    if cancellation.is_cancelled() {
        return Err(InvocationResult::Cancelled);
    }
    let status = child.wait().await.map_err(|error| InvocationResult::Failed(error.to_string()))?;
    let stderr_tail = stderr_task.await.unwrap_or_default();
    if !completed {
        return Err(InvocationResult::Failed(if stderr_tail.is_empty() {
            "The bundled helper exited without a job_completed event.".to_string()
        } else {
            "The bundled helper exited without completing the job. Sign in to TIDAL in Sone and try again.".to_string()
        }));
    }
    if !status.success() {
        return Err(InvocationResult::Failed("The bundled helper reported that the download job failed.".to_string()));
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
    use super::{
        frontend_event_name, parse_download_event, parse_refresh, tiddl_executable_from,
        BUNDLED_TIDDL_EXECUTABLE, HelperCredentials, InvocationResult,
    };
    use std::ffi::OsString;
    use std::io::{Read, Write};
    use std::os::unix::net::UnixStream;

    #[test]
    fn converts_downloader_event_names_to_frontend_event_names() {
        assert_eq!(
            frontend_event_name("item_discovered"),
            "download:item-discovered"
        );
        assert_eq!(frontend_event_name("job_failed"), "download:job-failed");
    }

    #[test]
    fn resolves_the_packaged_helper_by_default() {
        assert_eq!(
            tiddl_executable_from(None),
            std::path::PathBuf::from(BUNDLED_TIDDL_EXECUTABLE)
        );
    }

    #[test]
    fn uses_the_development_helper_override() {
        assert_eq!(
            tiddl_executable_from(Some(OsString::from("/tmp/sone-tiddl"))),
            std::path::PathBuf::from("/tmp/sone-tiddl")
        );
    }

    #[test]
    fn accepts_a_complete_private_credential_refresh() {
        let Ok(credentials) = parse_refresh(r#"{"type":"credentials_refreshed","credentials":{"access_token":"updated-access","refresh_token":"updated-refresh","user_id":"42","country_code":"US","client_id":"client-id","client_secret":"client-secret","expires_at":123,"proxy_url":null}}"#) else {
            panic!("the credential refresh should be valid");
        };

        assert_eq!(credentials.access_token, "updated-access");
        assert_eq!(credentials.refresh_token, "updated-refresh");
        assert_eq!(credentials.expires_at, 123);
    }

    #[test]
    fn rejects_malformed_or_unexpected_private_credential_updates() {
        for message in [
            "not json",
            r#"{"type":"credentials","credentials":{}}"#,
            r#"{"type":"credentials_refreshed","credentials":{"access_token":"a","refresh_token":"r","user_id":"42","country_code":"US","client_id":"id","client_secret":"secret","unexpected":true}}"#,
        ] {
            assert!(matches!(parse_refresh(message), Err(InvocationResult::Failed(_))));
        }
    }

    #[test]
    fn transfers_credentials_only_over_the_private_socket() {
        let credentials = HelperCredentials {
            access_token: "access-token".to_string(),
            refresh_token: "refresh-token".to_string(),
            user_id: "42".to_string(),
            country_code: "US".to_string(),
            client_id: "client-id".to_string(),
            client_secret: "client-secret".to_string(),
            expires_at: 123,
            proxy_url: Some("socks5://localhost:1080".to_string()),
        };
        let payload = serde_json::to_vec(&super::CredentialMessage {
            r#type: "credentials",
            credentials,
        })
        .expect("credential payload serializes");
        let (mut parent, mut child) = UnixStream::pair().expect("socket pair is available");

        parent.write_all(&payload).expect("parent writes credentials");
        drop(parent);
        let mut received = Vec::new();
        child.read_to_end(&mut received).expect("child reads credentials");

        let message: serde_json::Value = serde_json::from_slice(&received).expect("valid JSON");
        assert_eq!(message["type"], "credentials");
        assert_eq!(message["credentials"]["access_token"], "access-token");
        assert_eq!(message["credentials"]["client_secret"], "client-secret");
    }

    #[test]
    fn rejects_malformed_schema_less_and_unknown_download_events() {
        for event in [
            "not json",
            r#"{"event":"job_started"}"#,
            r#"{"schema_version":2,"event":"job_started"}"#,
            r#"{"schema_version":1,"event":"unrecognized"}"#,
        ] {
            assert!(matches!(
                parse_download_event(event),
                Err(InvocationResult::Failed(_))
            ));
        }
    }

    #[test]
    fn accepts_all_supported_download_events() {
        for event in [
            "job_started",
            "item_discovered",
            "item_started",
            "item_progress",
            "item_completed",
            "item_skipped",
            "item_failed",
            "job_failed",
            "job_completed",
        ] {
            let line = format!(r#"{{"schema_version":1,"event":"{event}"}}"#);
            let Ok((_, parsed_event)) = parse_download_event(&line) else {
                panic!("supported event should parse");
            };
            assert_eq!(parsed_event, event);
        }
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
            let directories = run_invocation(&app, &state, &destination, &quality, group, &cancellation).await?;
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
