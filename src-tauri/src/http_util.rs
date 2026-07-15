use tokio::net::TcpListener;
use tokio::task::JoinHandle;
use tokio_util::sync::CancellationToken;

/// Spawn an axum server that shuts down gracefully when `cancel` fires.
/// The returned task completes only after the listener is closed and all
/// in-flight connections have drained — await it before rebinding the same
/// address, or the bind races the old socket teardown (EADDRINUSE).
pub fn spawn_with_shutdown(
    listener: TcpListener,
    app: axum::Router,
    cancel: CancellationToken,
    name: &'static str,
) -> JoinHandle<()> {
    tokio::spawn(async move {
        if let Err(e) = axum::serve(listener, app)
            .with_graceful_shutdown(cancel.cancelled_owned())
            .await
        {
            log::error!("{name} server exited with error: {e}");
        }
        log::info!("{name} server shut down");
    })
}
