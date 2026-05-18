use rmcp::ErrorData;
use rmcp::schemars::JsonSchema;
use serde::Deserialize;

use crate::tidal_api::TidalClient;

#[derive(Deserialize, JsonSchema, Default)]
pub(super) struct NoArgs {}

pub(super) fn require_user_id(client: &TidalClient) -> Result<u64, ErrorData> {
    client
        .tokens
        .as_ref()
        .and_then(|t| t.user_id)
        .ok_or_else(|| ErrorData::internal_error("SONE is not signed in to Tidal", None))
}
