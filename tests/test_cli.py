from jarvis.cli import build_parser


def test_parser_accepts_status_command():
    parser = build_parser()
    args = parser.parse_args(["status"])
    assert args.command == "status"


def test_parser_accepts_note_text():
    parser = build_parser()
    args = parser.parse_args(["note", "measure gate width"])
    assert args.command == "note"
    assert args.text == "measure gate width"
