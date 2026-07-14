//! Tiny XML extraction helpers over quick-xml for the small, fixed-shape
//! documents Sonos returns (SOAP responses, device descriptions, topology,
//! account lists). Namespace prefixes are ignored — matching is on local name.

use quick_xml::events::Event;
use quick_xml::Reader;
use std::collections::BTreeMap;

use crate::error::SoneError;

fn protocol_err(e: impl std::fmt::Display) -> SoneError {
    SoneError::SonosProtocol(format!("XML parse: {e}"))
}

/// quick-xml ≥0.38 reports entity references as separate `GeneralRef` events
/// instead of resolving them inside `Text`. Resolve the predefined XML
/// entities plus numeric character references.
fn resolve_entity(name: &str) -> String {
    match name {
        "amp" => "&".to_string(),
        "lt" => "<".to_string(),
        "gt" => ">".to_string(),
        "quot" => "\"".to_string(),
        "apos" => "'".to_string(),
        _ => {
            let code = name
                .strip_prefix("#x")
                .or_else(|| name.strip_prefix("#X"))
                .and_then(|hex| u32::from_str_radix(hex, 16).ok())
                .or_else(|| name.strip_prefix('#').and_then(|dec| dec.parse().ok()));
            match code.and_then(char::from_u32) {
                Some(c) => c.to_string(),
                None => format!("&{name};"), // unknown entity: keep verbatim
            }
        }
    }
}

/// Text content of the first element with the given local name.
pub fn first_text(xml: &str, name: &str) -> Result<Option<String>, SoneError> {
    let mut reader = Reader::from_str(xml);
    let mut inside = false;
    let mut depth_when_entered = 0usize;
    let mut depth = 0usize;
    let mut out = String::new();
    loop {
        match reader.read_event().map_err(protocol_err)? {
            Event::Start(e) => {
                depth += 1;
                if !inside && e.local_name().as_ref() == name.as_bytes() {
                    inside = true;
                    depth_when_entered = depth;
                }
            }
            Event::End(_) => {
                if inside && depth == depth_when_entered {
                    return Ok(Some(out));
                }
                depth = depth.saturating_sub(1);
            }
            Event::Empty(e) => {
                if !inside && e.local_name().as_ref() == name.as_bytes() {
                    return Ok(Some(String::new()));
                }
            }
            Event::Text(t) => {
                if inside {
                    out.push_str(&t.xml_content().map_err(protocol_err)?);
                }
            }
            Event::GeneralRef(r) => {
                if inside {
                    out.push_str(&resolve_entity(&String::from_utf8_lossy(r.as_ref())));
                }
            }
            Event::CData(c) => {
                if inside {
                    out.push_str(&String::from_utf8_lossy(&c));
                }
            }
            Event::Eof => return Ok(None),
            _ => {}
        }
    }
}

/// Attribute maps for every element with the given local name
/// (both `<x .../>` and `<x ...>...</x>` forms).
pub fn elements_attrs(xml: &str, name: &str) -> Result<Vec<BTreeMap<String, String>>, SoneError> {
    let mut reader = Reader::from_str(xml);
    let mut out = Vec::new();
    loop {
        let event = reader.read_event().map_err(protocol_err)?;
        match &event {
            Event::Start(e) | Event::Empty(e) => {
                if e.local_name().as_ref() == name.as_bytes() {
                    let mut attrs = BTreeMap::new();
                    for attr in e.attributes() {
                        let attr =
                            attr.map_err(|e| SoneError::SonosProtocol(format!("XML attr: {e}")))?;
                        let key =
                            String::from_utf8_lossy(attr.key.local_name().as_ref()).into_owned();
                        let value = attr
                            .decode_and_unescape_value(reader.decoder())
                            .map_err(protocol_err)?
                            .into_owned();
                        attrs.insert(key, value);
                    }
                    out.push(attrs);
                }
            }
            Event::Eof => return Ok(out),
            _ => {}
        }
    }
}

/// Direct-child `name → text` map of the first element whose local name
/// matches `parent`. Used to pull the argument values out of a
/// `<u:{Action}Response>` element.
pub fn child_texts(xml: &str, parent: &str) -> Result<BTreeMap<String, String>, SoneError> {
    let mut reader = Reader::from_str(xml);
    let mut out = BTreeMap::new();
    let mut parent_depth: Option<usize> = None;
    let mut depth = 0usize;
    let mut current_child: Option<String> = None;
    let mut current_text = String::new();
    loop {
        match reader.read_event().map_err(protocol_err)? {
            Event::Start(e) => {
                depth += 1;
                if parent_depth.is_none() {
                    if e.local_name().as_ref() == parent.as_bytes() {
                        parent_depth = Some(depth);
                    }
                } else if Some(depth) == parent_depth.map(|d| d + 1) {
                    current_child =
                        Some(String::from_utf8_lossy(e.local_name().as_ref()).into_owned());
                    current_text.clear();
                }
            }
            Event::Empty(e) => {
                // An empty child element (`<Foo/>`) arrives while depth is
                // still the parent's depth (Empty events don't nest).
                if parent_depth == Some(depth) {
                    let name = String::from_utf8_lossy(e.local_name().as_ref()).into_owned();
                    out.insert(name, String::new());
                }
            }
            Event::Text(t) => {
                if current_child.is_some() {
                    current_text.push_str(&t.xml_content().map_err(protocol_err)?);
                }
            }
            Event::GeneralRef(r) => {
                if current_child.is_some() {
                    current_text.push_str(&resolve_entity(&String::from_utf8_lossy(r.as_ref())));
                }
            }
            Event::End(_) => {
                if let Some(pd) = parent_depth {
                    if depth == pd + 1 {
                        if let Some(name) = current_child.take() {
                            out.insert(name, std::mem::take(&mut current_text));
                        }
                    } else if depth == pd {
                        return Ok(out);
                    }
                }
                depth = depth.saturating_sub(1);
            }
            Event::Eof => return Ok(out),
            _ => {}
        }
    }
}

/// Escape a string for embedding as XML text or attribute content.
pub fn xml_escape(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for c in s.chars() {
        match c {
            '&' => out.push_str("&amp;"),
            '<' => out.push_str("&lt;"),
            '>' => out.push_str("&gt;"),
            '"' => out.push_str("&quot;"),
            '\'' => out.push_str("&apos;"),
            _ => out.push(c),
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn first_text_finds_nested_element() {
        let xml = "<root><a><roomName>Living Room</roomName></a></root>";
        assert_eq!(
            first_text(xml, "roomName").unwrap(),
            Some("Living Room".to_string())
        );
        assert_eq!(first_text(xml, "missing").unwrap(), None);
    }

    #[test]
    fn first_text_unescapes_entities() {
        let xml = "<r><t>Drake &amp; Rihanna &lt;3</t></r>";
        assert_eq!(
            first_text(xml, "t").unwrap(),
            Some("Drake & Rihanna <3".to_string())
        );
    }

    #[test]
    fn elements_attrs_collects_all_occurrences() {
        let xml = r#"<Accounts>
            <Account Type="44551" SerialNum="1" Deleted="0"/>
            <Account Type="2311" SerialNum="2" Deleted="1"></Account>
        </Accounts>"#;
        let accounts = elements_attrs(xml, "Account").unwrap();
        assert_eq!(accounts.len(), 2);
        assert_eq!(accounts[0]["Type"], "44551");
        assert_eq!(accounts[1]["Deleted"], "1");
    }

    #[test]
    fn child_texts_extracts_response_args() {
        let xml = r#"<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body>
            <u:GetPositionInfoResponse xmlns:u="urn:schemas-upnp-org:service:AVTransport:1">
              <Track>3</Track><RelTime>0:01:07</RelTime><TrackDuration>0:03:21</TrackDuration>
              <TrackMetaData>&lt;DIDL-Lite&gt;&lt;/DIDL-Lite&gt;</TrackMetaData>
            </u:GetPositionInfoResponse></s:Body></s:Envelope>"#;
        let args = child_texts(xml, "GetPositionInfoResponse").unwrap();
        assert_eq!(args["Track"], "3");
        assert_eq!(args["RelTime"], "0:01:07");
        assert_eq!(args["TrackMetaData"], "<DIDL-Lite></DIDL-Lite>");
    }

    #[test]
    fn xml_escape_all_specials() {
        assert_eq!(
            xml_escape(r#"a&b<c>d"e'f"#),
            "a&amp;b&lt;c&gt;d&quot;e&apos;f"
        );
    }
}
