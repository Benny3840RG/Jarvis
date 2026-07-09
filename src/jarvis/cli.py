from __future__ import annotations

import argparse
import json
from dataclasses import asdict, dataclass
from datetime import datetime
from pathlib import Path
from typing import Iterable

APP_DIR = Path.home() / ".jarvis"
NOTES_FILE = APP_DIR / "notes.jsonl"


@dataclass(frozen=True)
class Note:
    created_at: str
    text: str


def ensure_storage() -> None:
    APP_DIR.mkdir(parents=True, exist_ok=True)
    NOTES_FILE.touch(exist_ok=True)


def save_note(text: str) -> Note:
    cleaned = text.strip()
    if not cleaned:
        raise ValueError("Note text cannot be empty.")

    ensure_storage()
    note = Note(created_at=datetime.now().isoformat(timespec="seconds"), text=cleaned)
    with NOTES_FILE.open("a", encoding="utf-8") as file:
        file.write(json.dumps(asdict(note), ensure_ascii=False) + "\n")
    return note


def load_notes() -> list[Note]:
    ensure_storage()
    notes: list[Note] = []
    with NOTES_FILE.open("r", encoding="utf-8") as file:
        for line in file:
            if not line.strip():
                continue
            data = json.loads(line)
            notes.append(Note(created_at=data["created_at"], text=data["text"]))
    return notes


def print_lines(lines: Iterable[str]) -> None:
    for line in lines:
        print(line)


def command_status(_: argparse.Namespace) -> int:
    ensure_storage()
    print("Jarvis is working.")
    print(f"Storage: {APP_DIR}")
    print(f"Notes:   {NOTES_FILE}")
    return 0


def command_checklist(_: argparse.Namespace) -> int:
    print_lines(
        [
            "Jarvis daily checklist:",
            "1. Check calendar and booked jobs.",
            "2. Confirm client messages and invoice follow-ups.",
            "3. Load tools, PPE, fuel, batteries, and consumables.",
            "4. Check job scope, access, waste volume, and weather.",
            "5. Photograph before/during/after where useful.",
            "6. Record labour, materials, waste, travel, and extras before leaving site.",
            "7. Send quote/invoice/follow-up before the day gets away from you.",
        ]
    )
    return 0


def command_note(args: argparse.Namespace) -> int:
    try:
        note = save_note(args.text)
    except ValueError as error:
        print(f"Error: {error}")
        return 2

    print(f"Saved note at {note.created_at}: {note.text}")
    return 0


def command_notes(_: argparse.Namespace) -> int:
    notes = load_notes()
    if not notes:
        print("No notes saved yet.")
        return 0

    for index, note in enumerate(notes, start=1):
        print(f"{index}. [{note.created_at}] {note.text}")
    return 0


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="jarvis",
        description="A practical local assistant for jobs, notes, and daily trade workflow.",
    )
    subparsers = parser.add_subparsers(dest="command", required=True)

    status_parser = subparsers.add_parser("status", help="Check Jarvis is installed and working.")
    status_parser.set_defaults(func=command_status)

    checklist_parser = subparsers.add_parser("checklist", help="Print the daily trade checklist.")
    checklist_parser.set_defaults(func=command_checklist)

    note_parser = subparsers.add_parser("note", help="Save a local timestamped note.")
    note_parser.add_argument("text", help="Note text to save.")
    note_parser.set_defaults(func=command_note)

    notes_parser = subparsers.add_parser("notes", help="List saved notes.")
    notes_parser.set_defaults(func=command_notes)

    return parser


def main() -> int:
    parser = build_parser()
    args = parser.parse_args()
    return args.func(args)


if __name__ == "__main__":
    raise SystemExit(main())
