use rmcp::ErrorData;

use crate::tidal_api::TidalClient;

pub(super) fn require_user_id(client: &TidalClient) -> Result<u64, ErrorData> {
    client
        .tokens
        .as_ref()
        .and_then(|t| t.user_id)
        .ok_or_else(|| ErrorData::internal_error("SONE is not signed in to Tidal", None))
}
