from pathlib import Path

path = Path(__file__).resolve().parents[2] / "typescript/openapi/jarvis.openapi.json"
text = path.read_text(encoding="utf-8")
text = text.replace(
    "Transitions the memory change set to rejectd without writing canonical memory.",
    "Transitions the memory change set to rejected without writing canonical memory.",
)
path.write_text(text, encoding="utf-8")
