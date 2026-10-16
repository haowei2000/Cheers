//! Globally scoped resource names. Authority identifies an installation, never grants access.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct GlobalResourceUri {
    pub service_id: String,
    pub kind: String,
    pub resource_id: String,
    pub version: Option<i64>,
    pub fragment: Option<String>,
}

fn uuid(value: &str) -> bool {
    value.len() == 36
        && value.bytes().enumerate().all(|(i, b)| {
            if [8, 13, 18, 23].contains(&i) {
                b == b'-'
            } else {
                b.is_ascii_hexdigit()
            }
        })
}
pub fn parse(uri: &str) -> Option<GlobalResourceUri> {
    if uri.len() > 2048 {
        return None;
    }
    let rest = uri.strip_prefix("cheers:resource/")?;
    let (body, fragment) = rest
        .split_once('#')
        .map_or((rest, None), |(b, f)| (b, Some(f)));
    let fragment = match fragment {
        Some(f)
            if f.starts_with('^')
                && f.as_bytes()
                    .get(1)
                    .is_some_and(|b| b.is_ascii_alphanumeric())
                && f[1..].len() <= 128
                && f[1..]
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b"._:-".contains(&b)) =>
        {
            Some(f.to_owned())
        }
        Some(f)
            if f.starts_with('L')
                && f[1..].split("-L").count() <= 2
                && f[1..].split("-L").all(|v| {
                    !v.is_empty()
                        && v.bytes().all(|b| b.is_ascii_digit())
                        && v.parse::<u32>().is_ok_and(|n| n > 0)
                }) =>
        {
            Some(f.to_owned())
        }
        Some(_) => return None,
        None => None,
    };
    let (body, version) = match body.split_once('?') {
        Some((b, q)) => (
            b,
            Some(
                q.strip_prefix("v=")
                    .filter(|v| {
                        v.as_bytes()
                            .first()
                            .is_some_and(|b| matches!(b, b'1'..=b'9'))
                            && v.bytes().all(|b| b.is_ascii_digit())
                    })?
                    .parse::<i64>()
                    .ok()
                    .filter(|n| *n > 0 && *n <= 9_007_199_254_740_991)?,
            ),
        ),
        None => (body, None),
    };
    let parts: Vec<_> = body.split('/').collect();
    if parts.len() != 3
        || !uuid(parts[0])
        || !uuid(parts[2])
        || ![
            "desk", "inbox", "msg", "plan", "sessions", "cost", "activity",
        ]
        .contains(&parts[1])
    {
        return None;
    }
    if version.is_some() && parts[1] != "desk" {
        return None;
    }
    if fragment.is_some() && parts[1] != "desk" {
        return None;
    }
    Some(GlobalResourceUri {
        service_id: parts[0].to_ascii_lowercase(),
        kind: parts[1].into(),
        resource_id: parts[2].to_ascii_lowercase(),
        version,
        fragment,
    })
}
pub fn format(service_id: &str, kind: &str, resource_id: &str, version: Option<i64>) -> String {
    format!(
        "cheers:resource/{}/{}/{}{}",
        service_id,
        kind,
        resource_id,
        version.map_or(String::new(), |v| format!("?v={v}"))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    const S: &str = "11111111-2222-3333-4444-555555555555";
    #[test]
    fn identities_and_versions_are_strict() {
        let uri = format(S, "desk", S, Some(2));
        assert_eq!(parse(&uri).unwrap().version, Some(2));
        assert!(parse(&format!("{uri}#^topic")).is_some());
        for suffix in ["?v=0", "?v=1&v=2", "?v=-1", "#L0", "#^", "/../x"] {
            assert!(parse(&format!("{}{}", format(S, "desk", S, None), suffix)).is_none());
        }
        assert!(parse(&format(S, "msg", S, Some(1))).is_none());
    }
}
