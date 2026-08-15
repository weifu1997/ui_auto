from autoflow.picker import picker_injection_script, picker_score


def test_picker_score_degrades_with_count():
    assert picker_score("testid", 1) == 98
    assert picker_score("testid", 2) == 86
    assert picker_score("testid", 0) == 0


def test_picker_injection_script_keeps_test_id_attribute():
    script = picker_injection_script("data-testid")
    assert "autoflowDebugPickerCapture" in script
    assert 'data-testid' in script
