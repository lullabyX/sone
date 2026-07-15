use std::net::SocketAddr;
use std::sync::Arc;
use tokio::sync::{broadcast, Semaphore};
use tokio_util::sync::CancellationToken;
use axum::{
    Router,
    extract::State,
    http::StatusCode,
    response::{Html, Response, Sse},
    routing::get,
};
use axum::response::sse::{Event, KeepAlive};
use futures_util::stream::Stream;
use tokio_stream::wrappers::BroadcastStream;
use tokio_stream::StreamExt;

use crate::error::SoneError;
use super::state::OverlayStateRef;

const MAX_SSE_CONNECTIONS: usize = 16;

pub struct OverlayHandle {
    pub port: u16,
    pub host: String,
    pub cancel: CancellationToken,
    pub task: tokio::task::JoinHandle<()>,
}

impl OverlayHandle {
    pub fn url(&self) -> String {
        // 0.0.0.0 is a bind-all wildcard, not a connectable address — show
        // loopback in the URL users copy into OBS.
        let display_host = if self.host == "0.0.0.0" {
            "127.0.0.1"
        } else {
            self.host.as_str()
        };
        format!("http://{}:{}/overlay", display_host, self.port)
    }

    /// Stop the server and wait until the listener is released and all
    /// connections are closed. Must complete before rebinding the same addr.
    pub async fn shutdown(self) {
        self.cancel.cancel();
        let _ = self.task.await;
    }
}

// ---------------------------------------------------------------------------
// Default theme CSS — used before the frontend pushes the real theme.
// Uses Violet Night values so the overlay looks reasonable out of the box.
// ---------------------------------------------------------------------------
const DEFAULT_THEME_CSS: &str = "\
:root {
  --th-bg-base: #130F1A;
  --th-bg-surface: #1A1525;
  --th-bg-elevated: #231C30;
  --th-bg-inset: #1E1829;
  --th-accent: #A855F7;
  --th-accent-hover: #B97AF7;
  --th-on-accent: #ffffff;
  --th-text-primary: #F5F0FF;
  --th-text-secondary: rgba(245,240,255,0.72);
  --th-text-muted: rgba(245,240,255,0.45);
  --th-text-faint: rgba(245,240,255,0.28);
  --th-border-subtle: rgba(245,240,255,0.08);
  --th-slider-fill: #A855F7;
  --th-slider-track: rgba(245,240,255,0.14);
}";

const OVERLAY_HTML: &str = r#"<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>SONE Overlay</title>
<link rel="stylesheet" id="theme-css" href="/overlay/theme.css">
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  html, body {
    background: transparent;
    width: 400px;
    height: 120px;
    overflow: hidden;
    font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif;
  }

  #widget {
    width: 400px;
    height: 120px;
    display: flex;
    align-items: center;
    gap: 14px;
    background: color-mix(in srgb, var(--th-bg-base) 80%, transparent);
    backdrop-filter: blur(18px) saturate(1.6);
    -webkit-backdrop-filter: blur(18px) saturate(1.6);
    border: 1px solid var(--th-border-subtle);
    border-radius: 16px;
    padding: 12px 18px 12px 12px;

    opacity: 0;
    transform: translateY(18px);
    transition: opacity 0.45s cubic-bezier(.4,0,.2,1),
                transform 0.45s cubic-bezier(.4,0,.2,1);
  }

  #widget.visible {
    opacity: 1;
    transform: translateY(0);
  }

  #cover-wrap {
    position: relative;
    flex-shrink: 0;
    width: 72px;
    height: 72px;
    border-radius: 10px;
    overflow: hidden;
    background: var(--th-bg-inset);
  }

  #cover-img {
    width: 100%;
    height: 100%;
    object-fit: cover;
    border-radius: 10px;
    display: block;
  }

  #cover-placeholder {
    width: 100%;
    height: 100%;
    display: flex;
    align-items: center;
    justify-content: center;
  }

  #cover-placeholder svg {
    opacity: 0.25;
    fill: var(--th-text-primary);
  }

  .text-block {
    flex: 1;
    min-width: 0;
    display: flex;
    flex-direction: column;
    gap: 4px;
  }

  .text-top {
    display: flex;
    align-items: center;
    gap: 8px;
  }

  #title {
    flex: 1;
    min-width: 0;
    font-size: 14px;
    font-weight: 600;
    color: var(--th-text-primary);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    letter-spacing: -0.01em;
  }

  .artist-row {
    display: flex;
    align-items: center;
    gap: 6px;
    min-width: 0;
  }

  #artist {
    font-size: 12px;
    color: var(--th-text-muted);
    white-space: nowrap;
    overflow: hidden;
    text-overflow: ellipsis;
    flex: 1;
    min-width: 0;
  }

  /* Quality badge */
  #quality-badge {
    display: none;
    flex-shrink: 0;
    align-items: center;
    padding: 1px 5px;
    border-radius: 4px;
    background: color-mix(in srgb, var(--th-accent) 14%, transparent);
    border: 1px solid color-mix(in srgb, var(--th-accent) 30%, transparent);
    font-size: 9px;
    font-weight: 700;
    letter-spacing: 0.06em;
    color: var(--th-accent);
    white-space: nowrap;
    text-transform: uppercase;
    line-height: 1.6;
  }

  #quality-badge.visible {
    display: flex;
  }

  /* Progress row */
  .progress-row {
    display: flex;
    align-items: center;
    gap: 7px;
    margin-top: 2px;
  }

  .progress-track {
    flex: 1;
    height: 3px;
    border-radius: 99px;
    background: var(--th-slider-track);
    overflow: hidden;
  }

  .progress-fill {
    height: 100%;
    border-radius: 99px;
    background: var(--th-accent);
    width: 0%;
    transition: width 1.05s linear;
  }

  .time-label {
    font-size: 10px;
    font-variant-numeric: tabular-nums;
    color: var(--th-text-faint);
    white-space: nowrap;
    flex-shrink: 0;
    letter-spacing: 0.02em;
  }

  /* Playing icon — uses accent colour */
  #playing-icon {
    display: flex;
    align-items: flex-end;
    gap: 2.5px;
    height: 16px;
    flex-shrink: 0;
  }

  #playing-icon .bar {
    width: 3px;
    border-radius: 2px;
    background: var(--th-accent);
    animation: bounce 0.9s ease-in-out infinite;
    transform-origin: bottom;
  }

  #playing-icon .bar:nth-child(1) { height: 8px;  animation-delay: 0s; }
  #playing-icon .bar:nth-child(2) { height: 14px; animation-delay: 0.18s; }
  #playing-icon .bar:nth-child(3) { height: 6px;  animation-delay: 0.36s; }

  #playing-icon.paused .bar {
    animation-play-state: paused;
    opacity: 0.35;
  }

  @keyframes bounce {
    0%, 100% { transform: scaleY(0.4); }
    50%       { transform: scaleY(1);   }
  }
</style>
</head>
<body>
<div id="widget">
  <div id="cover-wrap">
    <img id="cover-img" src="" alt="" style="display:none">
    <div id="cover-placeholder">
      <svg width="24" height="24" viewBox="0 0 24 24">
        <path d="M12 3v10.55A4 4 0 1 0 14 17V7h4V3h-6z"/>
      </svg>
    </div>
  </div>
  <div class="text-block">
    <div class="text-top">
      <div id="title">—</div>
      <div id="playing-icon" class="paused">
        <div class="bar"></div>
        <div class="bar"></div>
        <div class="bar"></div>
      </div>
    </div>
    <div class="artist-row">
      <div id="artist">—</div>
      <span id="quality-badge"></span>
    </div>
    <div class="progress-row">
      <span class="time-label" id="time-elapsed">0:00</span>
      <div class="progress-track">
        <div class="progress-fill" id="progress-fill"></div>
      </div>
      <span class="time-label" id="time-total">0:00</span>
    </div>
  </div>
</div>

<script>
  const widget       = document.getElementById('widget');
  const coverImg     = document.getElementById('cover-img');
  const coverPlaceholder = document.getElementById('cover-placeholder');
  const titleEl      = document.getElementById('title');
  const artistEl     = document.getElementById('artist');
  const qualityBadge = document.getElementById('quality-badge');
  const playingIcon  = document.getElementById('playing-icon');
  const progressFill = document.getElementById('progress-fill');
  const timeElapsed  = document.getElementById('time-elapsed');
  const timeTotal    = document.getElementById('time-total');

  // Local interpolation state
  let positionSec  = 0;
  let durationSec  = 0;
  let isPlaying    = false;
  let lastSyncTime = 0;
  let rafId        = null;
  let currentTitle = '';

  function fmt(s) {
    if (!isFinite(s) || s < 0) s = 0;
    const m = Math.floor(s / 60);
    const ss = Math.floor(s % 60);
    return m + ':' + String(ss).padStart(2, '0');
  }

  function renderProgress() {
    const elapsed = isPlaying
      ? positionSec + (performance.now() - lastSyncTime) / 1000
      : positionSec;
    const clamped = Math.min(elapsed, durationSec || elapsed);
    const pct = durationSec > 0 ? (clamped / durationSec) * 100 : 0;
    progressFill.style.width = pct.toFixed(2) + '%';
    timeElapsed.textContent  = fmt(clamped);
    timeTotal.textContent    = fmt(durationSec);
  }

  function tick() {
    renderProgress();
    if (isPlaying) rafId = requestAnimationFrame(tick);
  }

  function startTick() { if (!rafId) rafId = requestAnimationFrame(tick); }

  function stopTick() {
    if (rafId) { cancelAnimationFrame(rafId); rafId = null; }
    renderProgress();
  }

  function applyState(state) {
    const isNew = state.title !== currentTitle;
    currentTitle = state.title;

    titleEl.textContent  = state.title  || '—';
    artistEl.textContent = state.artist || '—';

    // Quality badge
    const q = state.quality || '';
    qualityBadge.textContent = q;
    qualityBadge.classList.toggle('visible', q.length > 0);

    positionSec  = state.positionSeconds  ?? 0;
    durationSec  = state.durationSeconds  ?? 0;
    lastSyncTime = performance.now();
    isPlaying    = !!state.isPlaying;

    if (isNew) {
      progressFill.style.transition = 'none';
      requestAnimationFrame(() => { progressFill.style.transition = ''; });
    }

    if (state.coverUrl) {
      coverImg.src = state.coverUrl;
      coverImg.style.display = 'block';
      coverPlaceholder.style.display = 'none';
    } else {
      coverImg.style.display = 'none';
      coverPlaceholder.style.display = 'flex';
    }

    playingIcon.classList.toggle('paused', !state.isPlaying);
    if (isPlaying) { startTick(); } else { stopTick(); }

    if (state.title) {
      if (isNew) {
        widget.classList.remove('visible');
        requestAnimationFrame(() => {
          requestAnimationFrame(() => widget.classList.add('visible'));
        });
      } else {
        widget.classList.add('visible');
      }
    } else {
      widget.classList.remove('visible');
      stopTick();
    }
  }

  // ---- SSE: state updates ----
  const evtSource = new EventSource('/overlay/events');
  evtSource.addEventListener('state', (e) => {
    try { applyState(JSON.parse(e.data)); } catch {}
  });

  // ---- SSE: theme updates — reload the <link> tag ----
  evtSource.addEventListener('theme', () => {
    const link = document.getElementById('theme-css');
    // Bust cache with a timestamp query param so the browser re-fetches
    link.href = '/overlay/theme.css?t=' + Date.now();
  });

  evtSource.onerror = () => {};

  // ---- Initial fetch ----
  fetch('/overlay/state')
    .then(r => r.json())
    .then(applyState)
    .catch(() => {});
</script>
</body>
</html>"#;

#[derive(Clone)]
struct AppCtx {
    state: OverlayStateRef,
    tx: Arc<broadcast::Sender<String>>,
    cancel: CancellationToken,
    sse_permits: Arc<Semaphore>,
}

async fn serve_html() -> Html<&'static str> {
    Html(OVERLAY_HTML)
}

async fn serve_state(State(ctx): State<AppCtx>) -> Response {
    let state = ctx.state.read().await;
    let track = state.track.clone().unwrap_or_default();
    let json = serde_json::to_string(&track).unwrap_or_else(|_| "{}".to_string());
    axum::response::Response::builder()
        .header("Content-Type", "application/json")
        .body(axum::body::Body::from(json))
        .unwrap()
}

async fn serve_theme_css(State(ctx): State<AppCtx>) -> Response {
    let state = ctx.state.read().await;
    let css = if state.theme_css.is_empty() {
        DEFAULT_THEME_CSS.to_string()
    } else {
        state.theme_css.clone()
    };
    axum::response::Response::builder()
        .header("Content-Type", "text/css; charset=utf-8")
        .header("Cache-Control", "no-store")
        .body(axum::body::Body::from(css))
        .unwrap()
}

async fn serve_sse(
    State(ctx): State<AppCtx>,
) -> Result<Sse<impl Stream<Item = Result<Event, std::convert::Infallible>>>, StatusCode> {
    // Each connection holds a task and two broadcast subscriptions for its
    // whole lifetime — cap them.
    let permit = ctx
        .sse_permits
        .clone()
        .try_acquire_owned()
        .map_err(|_| StatusCode::SERVICE_UNAVAILABLE)?;

    // Merge both broadcast channels into a single SSE stream.
    // State events carry JSON; theme events just carry a "reload" signal.
    let state_rx = ctx.tx.subscribe();
    let theme_rx = ctx.state.read().await.theme_tx.subscribe();

    let state_stream = BroadcastStream::new(state_rx).filter_map(|msg| match msg {
        Ok(data) => Some(Ok(Event::default().event("state").data(data))),
        Err(_) => None,
    });

    let theme_stream = BroadcastStream::new(theme_rx).filter_map(|msg| match msg {
        Ok(_) => Some(Ok(Event::default().event("theme").data("reload"))),
        Err(_) => None,
    });

    let merged = tokio_stream::StreamExt::merge(state_stream, theme_stream);
    // SSE bodies never end on their own — end them on shutdown so graceful
    // shutdown can drain the connection instead of hanging forever. The
    // permit rides in the closure so it is released when the stream drops.
    let merged =
        futures_util::StreamExt::take_until(merged, ctx.cancel.clone().cancelled_owned());
    let merged = futures_util::StreamExt::inspect(merged, move |_| {
        let _ = &permit;
    });
    Ok(Sse::new(merged).keep_alive(KeepAlive::default()))
}

pub async fn start_server(
    state: OverlayStateRef,
    tx: broadcast::Sender<String>,
    host: &str,
    port: u16,
) -> Result<OverlayHandle, SoneError> {
    let cancel = CancellationToken::new();

    let ctx = AppCtx {
        state,
        tx: Arc::new(tx),
        cancel: cancel.clone(),
        sse_permits: Arc::new(Semaphore::new(MAX_SSE_CONNECTIONS)),
    };

    let app = Router::new()
        .route("/overlay", get(serve_html))
        .route("/overlay/state", get(serve_state))
        .route("/overlay/theme.css", get(serve_theme_css))
        .route("/overlay/events", get(serve_sse))
        .with_state(ctx);

    let addr: SocketAddr = format!("{host}:{port}")
        .parse()
        .map_err(|e| SoneError::Io(format!("overlay parse addr '{host}:{port}': {e}")))?;

    let listener = tokio::net::TcpListener::bind(addr)
        .await
        .map_err(|e| SoneError::Io(format!("overlay bind {addr}: {e}")))?;

    let bound_port = listener
        .local_addr()
        .map_err(|e| SoneError::Io(format!("overlay local_addr: {e}")))?
        .port();

    let host_owned = host.to_string();
    log::info!(
        "Overlay server listening on http://{}:{}/overlay",
        host_owned,
        bound_port
    );

    let task = crate::http_util::spawn_with_shutdown(listener, app, cancel.clone(), "Overlay");

    Ok(OverlayHandle {
        port: bound_port,
        host: host_owned,
        cancel,
        task,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::Duration;
    use tokio::io::{AsyncReadExt, AsyncWriteExt};

    async fn start_on_ephemeral() -> (OverlayHandle, crate::overlay::OverlayStateRef) {
        let (state, _rx, _theme_rx) = crate::overlay::new_state();
        let tx = state.read().await.tx.clone();
        let handle = start_server(state.clone(), tx, "127.0.0.1", 0)
            .await
            .unwrap();
        (handle, state)
    }

    async fn open_sse(port: u16) -> tokio::net::TcpStream {
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", port))
            .await
            .unwrap();
        stream
            .write_all(
                b"GET /overlay/events HTTP/1.1\r\nHost: 127.0.0.1\r\nAccept: text/event-stream\r\n\r\n",
            )
            .await
            .unwrap();
        let mut buf = [0u8; 1024];
        let n = stream.read(&mut buf).await.unwrap();
        assert!(n > 0, "no SSE response headers");
        stream
    }

    #[tokio::test]
    async fn shutdown_disconnects_sse_clients() {
        let (handle, _state) = start_on_ephemeral().await;
        let mut stream = open_sse(handle.port).await;

        tokio::time::timeout(Duration::from_secs(5), handle.shutdown())
            .await
            .expect("shutdown timed out with a live SSE client");

        let mut buf = [0u8; 1024];
        tokio::time::timeout(Duration::from_secs(5), async {
            loop {
                match stream.read(&mut buf).await {
                    Ok(0) => break,
                    Ok(_) => continue,
                    Err(_) => break,
                }
            }
        })
        .await
        .expect("connection not closed after shutdown");
    }

    #[tokio::test]
    async fn restart_rebinds_same_port_immediately() {
        let (mut handle, state) = start_on_ephemeral().await;
        let port = handle.port;
        for i in 0..20 {
            let _stream = if i % 2 == 0 {
                Some(open_sse(port).await)
            } else {
                None
            };
            handle.shutdown().await;
            let tx = state.read().await.tx.clone();
            handle = start_server(state.clone(), tx, "127.0.0.1", port)
                .await
                .unwrap_or_else(|e| panic!("rebind {i} failed: {e:?}"));
        }
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn sse_connections_capped_with_503() {
        let (handle, _state) = start_on_ephemeral().await;
        let mut held = Vec::new();
        for _ in 0..MAX_SSE_CONNECTIONS {
            held.push(open_sse(handle.port).await);
        }
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", handle.port))
            .await
            .unwrap();
        stream
            .write_all(b"GET /overlay/events HTTP/1.1\r\nHost: 127.0.0.1\r\n\r\n")
            .await
            .unwrap();
        let mut buf = [0u8; 256];
        let n = stream.read(&mut buf).await.unwrap();
        let head = String::from_utf8_lossy(&buf[..n]);
        assert!(head.contains("503"), "expected 503 over cap, got: {head}");
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn state_endpoint_has_no_cors_header() {
        let (handle, _state) = start_on_ephemeral().await;
        let mut stream = tokio::net::TcpStream::connect(("127.0.0.1", handle.port))
            .await
            .unwrap();
        stream
            .write_all(
                b"GET /overlay/state HTTP/1.1\r\nHost: 127.0.0.1\r\nConnection: close\r\n\r\n",
            )
            .await
            .unwrap();
        let mut body = String::new();
        stream.read_to_string(&mut body).await.unwrap();
        assert!(
            !body.to_ascii_lowercase().contains("access-control-allow-origin"),
            "CORS header must be gone"
        );
        handle.shutdown().await;
    }

    #[tokio::test]
    async fn url_shows_loopback_for_wildcard_host() {
        let (state, _rx, _theme_rx) = crate::overlay::new_state();
        let tx = state.read().await.tx.clone();
        let handle = start_server(state.clone(), tx, "0.0.0.0", 0).await.unwrap();
        assert!(
            handle.url().starts_with("http://127.0.0.1:"),
            "got: {}",
            handle.url()
        );
        handle.shutdown().await;
    }
}
