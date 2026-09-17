use tether_core::{ResponseBudget, ResponseMode};

#[test]
fn compact_budget_truncates_large_utf8_output_on_a_character_boundary() {
    let budget = ResponseBudget {
        mode: ResponseMode::Compact,
        max_bytes: 1_025,
        max_items: 32,
    };
    let input = "😀".repeat(30_000);

    let result = budget.apply_text(&input, 0).unwrap();

    assert!(result.content.len() <= budget.max_bytes);
    let continuation = result.continuation.expect("large output must continue");
    assert!(input.is_char_boundary(continuation.offset));
    assert_eq!(result.content, input[..continuation.offset]);
}

#[test]
fn debug_budget_is_larger_but_still_bounded() {
    let compact = ResponseBudget::for_mode(ResponseMode::Compact);
    let debug = ResponseBudget::for_mode(ResponseMode::Debug);
    assert!(debug.max_bytes > compact.max_bytes);

    let input = "x".repeat(debug.max_bytes + 4_096);
    let result = debug.apply_text(&input, 0).unwrap();

    assert_eq!(result.content.len(), debug.max_bytes);
    assert_eq!(result.continuation.unwrap().offset, debug.max_bytes);
}

#[test]
fn item_budget_returns_only_the_bounded_slice_and_a_cursor() {
    let budget = ResponseBudget {
        mode: ResponseMode::Normal,
        max_bytes: 1024,
        max_items: 3,
    };
    let items = vec![1, 2, 3, 4, 5];

    let result = budget.apply_items(&items, 0).unwrap();

    assert_eq!(result.items, vec![1, 2, 3]);
    assert_eq!(result.continuation.unwrap().offset, 3);
}

#[test]
fn continuation_offsets_must_land_on_utf8_boundaries() {
    let budget = ResponseBudget {
        mode: ResponseMode::Compact,
        max_bytes: 5,
        max_items: 1,
    };
    let input = "éééé";

    let result = budget.apply_text(input, 0).unwrap();

    assert_eq!(result.content, "éé");
    assert_eq!(result.continuation.unwrap().offset, 4);
}
