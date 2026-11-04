import { Check, Film, Minus, X } from "lucide-react";

import { type Act } from "../kit/act.ts";
import { Connector } from "../kit/motion/Connector.tsx";
import { Stage } from "../kit/stage.tsx";
import "./route.css";

// How the Hub picks a Route, played once as it scrolls into view, with no
// cursor: what the system does. ffprobe reads a Media File's streams, each
// marked as the Selected TV plays it or not; then the four Routes, cheapest
// first, are tried in turn: the two that would send DTS to the TV are ruled
// out, Audio Conversion is taken, with a line from the stream that decided
// it, and Full Conversion isn't needed. The result holds: it plays on the TV.
//
// Real words: the file, its three streams, the four Routes and why, and where
// it plays. They are the subject; there is no filler.

type S = { step: number };
const START: S = { step: 0 };
const END: S = { step: 6 };

const script = async (a: Act<S>) => {
  await a.wait(300);
  a.put({ step: 1 }); // the file arrives, and ffprobe's streams under it
  await a.wait(1300);
  a.put({ step: 2 }); // the Routes arrive
  await a.wait(900);
  a.put({ step: 3 }); // Direct Play and Remux are ruled out
  await a.wait(1100);
  a.put({ step: 4 }); // Audio Conversion is taken, tied to the DTS stream
  await a.wait(1200);
  a.put({ step: 5 }); // Full Conversion isn't needed
  await a.wait(700);
  a.put({ step: 6 }); // it plays on the TV
};

type Verdict = "yes" | "no";
const STREAMS: { kind: string; codec: string; verdict: Verdict; target?: string }[] = [
  { kind: "Video", codec: "HEVC · 4K", verdict: "yes" },
  { kind: "Audio", codec: "DTS 5.1", verdict: "no", target: "dts" },
  { kind: "Subtitles", codec: "SRT", verdict: "yes" },
];

type Fate = "ruled-out" | "taken" | "unneeded";
const ROUTES: { name: string; why: string; fate: Fate; at: number; target?: string }[] = [
  { name: "Direct Play", why: "The TV can't play DTS", fate: "ruled-out", at: 3 },
  { name: "Remux", why: "The TV can't play DTS", fate: "ruled-out", at: 3 },
  { name: "Audio Conversion", why: "DTS to Dolby Digital", fate: "taken", at: 4, target: "taken" },
  { name: "Full Conversion", why: "Not needed", fate: "unneeded", at: 5 },
];

function Mark({ verdict }: { verdict: Verdict | "none" }) {
  return (
    <span className="mc-mark" data-verdict={verdict}>
      {verdict === "yes" ? (
        <Check size={12} strokeWidth={3} />
      ) : verdict === "no" ? (
        <X size={12} strokeWidth={3} />
      ) : (
        <Minus size={12} strokeWidth={3} />
      )}
    </span>
  );
}

export function Route({ theme, still }: { theme: "light" | "dark"; still: boolean }) {
  return (
    <Stage<S>
      width={1040}
      height={380}
      compact={{ below: 720, width: 358, height: 600 }}
      initial={START}
      poster={END}
      script={still ? undefined : script}
      play="once"
      theme={theme}
      greys="cool"
      className="mc-look mc-route"
    >
      {(s, rect, layout) => {
        const dts = rect("dts");
        const taken = rect("taken");
        return (
          <>
            <section className="mc-route__file" data-in={s.step >= 1 || undefined}>
              <div className="mc-route__head">
                <span className="mc-route__icon">
                  <Film size={18} strokeWidth={2} />
                </span>
                <span>
                  <span className="mc-route__title">Tears of Steel (2012).mkv</span>
                  <span className="mc-route__sub">As ffprobe reads it</span>
                </span>
              </div>
              {STREAMS.map((stream, i) => (
                <div
                  key={stream.kind}
                  className="mc-route__row"
                  data-target={stream.target}
                  data-in={s.step >= 1 || undefined}
                  style={{ transitionDelay: s.step >= 1 ? `${300 + i * 90}ms` : "0ms" }}
                >
                  <span className="mc-route__kind">{stream.kind}</span>
                  <span className="mc-route__codec">{stream.codec}</span>
                  <Mark verdict={stream.verdict} />
                </div>
              ))}
            </section>

            <section className="mc-route__routes" data-in={s.step >= 2 || undefined}>
              <div className="mc-route__label">Routes, cheapest first</div>
              {ROUTES.map((route, i) => {
                const decided = s.step >= route.at;
                return (
                  <div
                    key={route.name}
                    className="mc-route__route"
                    data-target={route.target}
                    data-fate={decided ? route.fate : undefined}
                    data-in={s.step >= 2 || undefined}
                    style={{ transitionDelay: s.step === 2 ? `${i * 80}ms` : "0ms" }}
                  >
                    <span className="mc-route__name">{route.name}</span>
                    <span className="mc-route__why" data-in={decided || undefined}>
                      {route.why}
                    </span>
                    <Mark
                      verdict={
                        !decided ? "none" : route.fate === "taken" ? "yes" : route.fate === "ruled-out" ? "no" : "none"
                      }
                    />
                  </div>
                );
              })}
              <div className="mc-route__result" data-in={s.step >= 6 || undefined}>
                <span className="mc-route__dot" />
                Playing on Living Room · TV
              </div>
            </section>

            {layout === "wide" && dts.width > 0 && taken.width > 0 && (
              <Connector
                show={s.step >= 4}
                from={{ x: dts.x + dts.width + 6, y: dts.y + dts.height / 2 }}
                to={{ x: taken.x - 6, y: taken.y + taken.height / 2 }}
                route="curve"
              />
            )}
          </>
        );
      }}
    </Stage>
  );
}
