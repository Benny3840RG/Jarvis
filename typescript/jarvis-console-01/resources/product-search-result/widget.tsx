import { AppsSDKUIProvider } from "@openai/apps-sdk-ui/components/AppsSDKUIProvider";
import { Button } from "@openai/apps-sdk-ui/components/Button";
import { Expand, PictureInPicture } from "@openai/apps-sdk-ui/components/Icon";
import {
  McpUseProvider,
  useWidget,
  type WidgetMetadata,
} from "mcp-use/react";
import React from "react";
import { Link } from "react-router";
import "../styles.css";
import type { JarvisConsoleProps } from "./types";
import { propSchema } from "./types";

export const widgetMetadata: WidgetMetadata = {
  description: "Jarvis Console 01 landscape command centre HUD",
  props: propSchema,
  exposeAsTool: false,
  metadata: {
    prefersBorder: false,
    invoking: "Powering Console 01...",
    invoked: "Console 01 online",
  },
};

const statusClass = (state: "good" | "guarded" | "pending") =>
  `status-chip status-${state}`;

const JarvisConsole: React.FC = () => {
  const {
    props,
    isPending,
    displayMode,
    requestDisplayMode,
    sendFollowUpMessage,
  } = useWidget<JarvisConsoleProps>();

  if (isPending) {
    return (
      <McpUseProvider>
        <div className="jarvis-shell jarvis-loading">
          <div className="loading-core" />
          <p>Powering Jarvis Console 01...</p>
        </div>
      </McpUseProvider>
    );
  }

  const isExpanded = displayMode === "fullscreen" || displayMode === "pip";

  return (
    <McpUseProvider>
      <AppsSDKUIProvider linkComponent={Link}>
        <main className="jarvis-shell">
          <header className="console-header">
            <div className="brand-lockup">
              <div className="mascot-mark" aria-hidden="true">
                <span className="mascot-eye left" />
                <span className="mascot-eye right" />
                <span className="mascot-mouth" />
              </div>
              <div>
                <p className="eyebrow">{props.phase}</p>
                <h1>{props.title}</h1>
              </div>
            </div>
            <div className="header-actions">
              <span className={`live-pill live-${props.status}`}>
                {props.status.toUpperCase()}
              </span>
              {!isExpanded ? (
                <>
                  <Button
                    color="secondary"
                    pill
                    size="md"
                    uniform
                    variant="outline"
                    onClick={() => requestDisplayMode("pip")}
                    title="Picture in picture"
                  >
                    <PictureInPicture />
                  </Button>
                  <Button
                    color="secondary"
                    pill
                    size="md"
                    uniform
                    variant="outline"
                    onClick={() => requestDisplayMode("fullscreen")}
                    title="Fullscreen"
                  >
                    <Expand />
                  </Button>
                </>
              ) : (
                <Button
                  color="secondary"
                  pill
                  size="md"
                  variant="outline"
                  onClick={() => requestDisplayMode("inline")}
                >
                  EXIT
                </Button>
              )}
            </div>
          </header>

          <section className="telemetry-strip">
            <div><span>DEPLOYMENT</span><strong>{props.deployment}</strong></div>
            <div><span>ENVIRONMENT</span><strong>{props.environment.toUpperCase()}</strong></div>
            <div><span>AUTHORITY</span><strong>CONTROLLED</strong></div>
            <div><span>TELEMETRY</span><strong>TRUTHFUL ONLY</strong></div>
          </section>

          <section className="console-grid">
            <aside className="left-rail">
              <div className="hud-panel system-core-panel">
                <div className="panel-title">SYSTEM CORE</div>
                <div className="mini-reactor">
                  <div className="mini-ring ring-a" />
                  <div className="mini-ring ring-b" />
                  <div className="mini-core">J</div>
                </div>
                <div className="core-stats">
                  <div><span>PHASE</span><strong>01</strong></div>
                  <div><span>HUD</span><strong>LIVE</strong></div>
                  <div><span>FAKE DATA</span><strong>0</strong></div>
                </div>
              </div>

              <div className="hud-panel task-stack">
                <div className="panel-title">MISSION STACK</div>
                {props.tasks.map((task, index) => (
                  <div className={`task-row task-${task.state}`} key={task.label}>
                    <span className="task-index">0{index + 1}</span>
                    <div>
                      <strong>{task.label}</strong>
                      <small>{task.state.toUpperCase()}</small>
                    </div>
                  </div>
                ))}
              </div>
            </aside>

            <section className="centre-stage">
              <div className="mission-copy">
                <p className="eyebrow">PRIMARY MISSION</p>
                <h2>{props.mission}</h2>
              </div>

              <div className="reactor-stage" aria-label={`${props.progress}% mission progress`}>
                <div className="energy-flare flare-a" />
                <div className="energy-flare flare-b" />
                <div className="reactor-ring outer" />
                <div className="reactor-ring middle" />
                <div className="reactor-ring inner" />
                <div className="reactor-progress" style={{ "--progress": `${props.progress}%` } as React.CSSProperties} />
                <div className="reactor-mascot" aria-hidden="true">
                  <span className="mascot-eye left" />
                  <span className="mascot-eye right" />
                  <span className="mascot-mouth" />
                </div>
                <div className="progress-copy">
                  <strong>{props.progress}%</strong>
                  <span>PHASE 1</span>
                </div>
              </div>

              <div className="command-row">
                <Button
                  color="primary"
                  size="lg"
                  onClick={() =>
                    sendFollowUpMessage({
                      prompt: "Continue Jarvis Console 01 Phase 1 with the Convex task and reminder bridge.",
                    })
                  }
                >
                  CONTINUE BUILD
                </Button>
                <Button
                  color="secondary"
                  size="lg"
                  variant="outline"
                  onClick={() =>
                    sendFollowUpMessage({
                      prompt: "Inspect the live Jarvis Console 01 deployment and report any faults.",
                    })
                  }
                >
                  RUN INSPECTION
                </Button>
              </div>
            </section>

            <aside className="right-rail">
              <div className="hud-panel systems-panel">
                <div className="panel-title">SYSTEM MATRIX</div>
                {props.systems.map((system) => (
                  <div className="system-row" key={system.label}>
                    <div>
                      <span>{system.label}</span>
                      <strong>{system.value}</strong>
                    </div>
                    <span className={statusClass(system.state)}>{system.state}</span>
                  </div>
                ))}
              </div>

              <div className="hud-panel waveform-panel">
                <div className="panel-title">JARVIS SIGNAL</div>
                <svg viewBox="0 0 360 120" role="img" aria-label="Decorative Jarvis signal waveform">
                  <path className="wave-grid" d="M0 20H360M0 60H360M0 100H360" />
                  <path className="wave purple" d="M0 70 C40 20 70 105 110 55 S180 15 220 65 S300 100 360 32" />
                  <path className="wave cyan" d="M0 78 C45 92 70 28 120 67 S185 102 230 44 S300 25 360 74" />
                </svg>
              </div>

              <div className="hud-panel activity-panel">
                <div className="panel-title">LIVE ACTIVITY</div>
                {props.activity.map((item, index) => (
                  <div className="activity-row" key={item}>
                    <span className="activity-dot" />
                    <div><strong>{item}</strong><small>EVENT {String(index + 1).padStart(2, "0")}</small></div>
                  </div>
                ))}
              </div>
            </aside>
          </section>

          <footer className="console-footer">
            <span>JARVIS PRIME OMNI · CONSOLE 01</span>
            <span>MANUFACT CLOUD · MCP APPS</span>
          </footer>
        </main>
      </AppsSDKUIProvider>
    </McpUseProvider>
  );
};

export default JarvisConsole;
