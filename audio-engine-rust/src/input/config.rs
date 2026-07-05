pub(crate) fn stable_index_id(prefix: &str, index: usize) -> String {
    format!("{}:{}", prefix, index)
}

pub(crate) fn join_json_objects(values: &[String]) -> String {
    values.join(",")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn stable_index_id_uses_prefix_and_index() {
        assert_eq!(stable_index_id("input", 3), "input:3");
    }
}
