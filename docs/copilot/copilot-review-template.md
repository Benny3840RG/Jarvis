name: Copilot Review Check

on:
  pull_request:
    types: [opened, edited, synchronize, reopened]

permissions:
  contents: read
  pull-requests: read

jobs:
  copilot-review-section:
    runs-on: ubuntu-latest
    steps:
      - name: Validate PR description quality
        uses: actions/github-script@v7
        with:
          script: |
            const body = context.payload.pull_request.body || "";

            function fail(msg) {
              core.setFailed(msg);
              return false;
            }

            const requiredSections = [
              "Summary",
              "Risks",
              "Testing",
              "Copilot Review",
            ];

            const sectionRegex = (name) =>
              new RegExp(`^#{1,6}\\s*${name}\\s*$`, "im");

            for (const section of requiredSections) {
              if (!sectionRegex(section).test(body)) {
                fail(
                  `PR description must include a '# ${section}' section (see .github/PULL_REQUEST_TEMPLATE.md).`
                );
                return;
              }
            }

            // Extract content under a markdown heading until next heading or end of body
            function getSectionContent(name) {
              const escaped = name.replace(/[.*+?^${}()|[\\]\\]/g, "\\$&");
              const rx = new RegExp(
                `(^#{1,6}\\s*${escaped}\\s*$)([\\s\\S]*?)(?=^#{1,6}\\s+[^\\n]+\\s*$|$)`,
                "im"
              );
              const m = body.match(rx);
              return (m?.[2] || "").trim();
            }

            const minCharsBySection = {
              Summary: 40,
              Risks: 30,
              Testing: 30,
              "Copilot Review": 40,
            };

            for (const [section, minChars] of Object.entries(minCharsBySection)) {
              const content = getSectionContent(section);
              // Remove markdown bullets/checklist markers for fair length counting
              const normalized = content
                .replace(/^\s*[-*]\s+/gm, "")
                .replace(/^\s*\d+\.\s+/gm, "")
                .replace(/^\s*\[[ xX]\]\s+/gm, "")
                .trim();

              if (normalized.length < minChars) {
                fail(
                  `# ${section} is too short (${normalized.length} chars). Please provide meaningful detail (minimum ${minChars} chars).`
                );
                return;
              }
            }

            const fillerPatterns = [
              /\b(lgtm|looks good to me|ship it)\b/i,
              /^\s*(n\/a|na|none|nope|ok|done)\s*$/im,
              /^\s*no regressions\.?\s*$/im,
              /^\s*no changes\.?\s*$/im,
              /^\s*tested\.?\s*$/im,
            ];

            const copilotContent = getSectionContent("Copilot Review");
            const normalizedCopilot = copilotContent
              .replace(/```[\s\S]*?```/g, "")
              .trim();

            for (const rx of fillerPatterns) {
              if (rx.test(normalizedCopilot)) {
                fail(
                  "# Copilot Review appears to contain placeholder/filler text. Add concrete review notes tied to code changes."
                );
                return;
              }
            }

            // If PR claims "Added files only", verify no modified/removed files exist.
            if (/\badded files only\b/i.test(body)) {
              const files = await github.paginate(github.rest.pulls.listFiles, {
                owner: context.repo.owner,
                repo: context.repo.repo,
                pull_number: context.payload.pull_request.number,
                per_page: 100,
              });

              const nonAdded = files.filter((f) => f.status !== "added");
              if (nonAdded.length > 0) {
                const sample = nonAdded.slice(0, 5).map((f) => `${f.filename} (${f.status})`).join(", ");
                fail(
                  `PR body says 'Added files only' but found non-added changes: ${sample}${
                    nonAdded.length > 5 ? ", ..." : ""
                  }`
                );
                return;
              }
            }

            core.info("PR description quality checks passed.");
