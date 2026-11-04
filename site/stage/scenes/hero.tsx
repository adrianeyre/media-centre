import {
  ChevronDown,
  ChevronLeft,
  ChevronRight,
  ChevronUp,
  Film,
  Flame,
  GripVertical,
  House,
  Lightbulb,
  Network,
  Pause,
  Play,
  Settings,
  Speaker,
  Square,
  Tv,
  Video,
  AirVent,
  FastForward,
  Rewind,
  type LucideIcon,
} from "lucide-react";

import { type Act } from "../kit/act.ts";
import { Collapse } from "../kit/motion/Collapse.tsx";
import { Count } from "../kit/motion/Count.tsx";
import { States } from "../kit/motion/States.tsx";
import { Swap } from "../kit/motion/Swap.tsx";
import { Spinner } from "../kit/parts/Spinner.tsx";
import { Phone } from "../kit/phone.tsx";
import { Stage } from "../kit/stage.tsx";
import { Bar, Text, Window } from "../kit/window.tsx";
import { BrandIcon } from "./brand-icon.tsx";
import "./hero.css";

// The hero: one film, two Remotes. The TV tab on a computer, and the same
// Remote on a phone straddling its right edge, over the Apps widget (filler)
// so the Now Playing widget the story is about stays clear.
//
// Story, about 11 seconds: a film is tapped in Watch & Listen on the phone;
// it starts on the TV from where it was stopped (its Resume Position), and
// both Remotes show it playing at once, the position counting on each; then
// Stop on the phone stops it, and both go back to nothing playing: the reset
// has a cause on screen.
//
// Real words: Media Centre, TV, the Selected TV, Now playing and the film with
// its position, OK, Watch & Listen, NAS › Films and three films. Everything
// else is filler.

type S = { loading: boolean; playing: boolean; at: number };

const START: S = { loading: false, playing: false, at: 372 };
const POSTER: S = { loading: false, playing: true, at: 377 };

const FILM = "Sintel (2010).mkv";
const LENGTH = 888;
const FILMS = [
  { name: "Big Buck Bunny (2008).mp4", length: "9:56" },
  { name: FILM, length: "14:48", target: "film" },
  { name: "Tears of Steel (2012).mkv", length: "12:14" },
];

const time = (seconds: number) => `${Math.floor(seconds / 60)}:${String(Math.round(seconds) % 60).padStart(2, "0")}`;

const script = async (a: Act<S>) => {
  await a.wait(1200);
  a.mark("tap");
  await a.click("film");
  a.put({ loading: true });
  await a.wait(800);
  a.mark("playing");
  a.put({ loading: false, playing: true });
  for (let i = 0; i < 5; i++) {
    await a.wait(1000);
    a.put((s) => ({ at: s.at + 1 }));
  }
  await a.wait(600);
  a.mark("stop");
  await a.click("stop");
  a.put({ playing: false });
  await a.wait(900);
  // Under "Nothing playing" now, so the position goes back unseen.
  await a.snap({ at: START.at });
  await a.wait(600);
};

const RAIL: { icon: LucideIcon; w: number }[] = [
  { icon: AirVent, w: 44 },
  { icon: Lightbulb, w: 38 },
  { icon: Flame, w: 48 },
  { icon: Network, w: 50 },
  { icon: Speaker, w: 46 },
  { icon: Video, w: 30 },
  { icon: House, w: 40 },
];

export function Hero({ theme, still }: { theme: "light" | "dark"; still: boolean }) {
  return (
    <Stage<S>
      width={1040}
      height={520}
      compact={{ below: 720, width: 358, height: 760 }}
      initial={START}
      poster={POSTER}
      script={still ? undefined : script}
      cursor={{ at: { wide: { x: 900, y: 470 }, compact: { x: 300, y: 730 } }, style: "touch" }}
      theme={theme}
      greys="cool"
      className="mc-look mc-hero"
    >
      {(s, _rect, layout) => (
        <>
          <div className="mc-hero__wash" />

          <Window url="localhost:41080" urlShape="pill" className="mc-hero__window">
            <div className="mc-app">
              <div className="mc-appbar">
                <span className="mc-brand">
                  <BrandIcon size={22} />
                  Media Centre
                </span>
                <span className="mc-online">
                  <span className="mc-online__dot" />
                  <Bar w={52} h={5} tone={3} />
                </span>
              </div>
              <div className="mc-app__body">
                <nav className="mc-rail">
                  <span className="mc-rail__item" data-on>
                    <Tv size={16} strokeWidth={2} />
                    TV
                  </span>
                  {RAIL.map(({ icon: Icon, w }, i) => (
                    <span key={i} className="mc-rail__item">
                      <Icon size={16} strokeWidth={2} />
                      <Bar w={w} h={6} tone={3} />
                    </span>
                  ))}
                </nav>

                <main className="mc-tv">
                  <div className="mc-tv__head">
                    <span className="mc-tv__title">TV</span>
                    <span className="mc-select">
                      <span>
                        <span className="mc-faint">Selected TV: </span>
                        <strong>Living Room · TV</strong>
                      </span>
                      <ChevronDown size={16} strokeWidth={2} />
                    </span>
                  </div>

                  <div className="mc-tv__grid">
                    <section className="mc-widget mc-playing" data-on={s.playing || undefined}>
                      {/* Nothing playing sits at 0:00; a film starts from its Resume Position. */}
                      <div className="mc-widget__head">
                        <span className="mc-label">Now playing</span>
                        <GripVertical className="mc-grip" size={14} />
                      </div>
                      <div className="mc-playing__title">
                        <Swap id={s.playing ? "film" : "none"}>
                          {s.playing ? FILM : <span className="mc-faint">Nothing playing</span>}
                        </Swap>
                      </div>
                      <div className="mc-seek">
                        <span className="mc-seek__time">
                          <Count value={s.playing ? s.at : 0} format={time} />
                        </span>
                        <span className="mc-seek__track">
                          <span
                            className="mc-seek__fill"
                            style={{ width: `${s.playing ? (s.at / LENGTH) * 100 : 0}%` }}
                          />
                          <span
                            className="mc-seek__knob"
                            style={{ left: `${s.playing ? (s.at / LENGTH) * 100 : 0}%` }}
                          />
                        </span>
                        <span className="mc-seek__time">{s.playing ? time(LENGTH) : "0:00"}</span>
                      </div>
                      <div className="mc-transport">
                        <span className="mc-key">
                          <span className="mc-skip">
                            <Rewind size={14} fill="currentColor" strokeWidth={0} />
                            30
                          </span>
                        </span>
                        <span className="mc-key">
                          <span className="mc-skip">
                            <Rewind size={14} fill="currentColor" strokeWidth={0} />
                            10
                          </span>
                        </span>
                        <span className="mc-key mc-key--play">
                          <States
                            value={s.playing ? "pause" : "play"}
                            states={{
                              play: <Play size={16} fill="currentColor" strokeWidth={0} />,
                              pause: <Pause size={16} fill="currentColor" strokeWidth={0} />,
                            }}
                          />
                        </span>
                        <span className="mc-key">
                          <span className="mc-skip">
                            10
                            <FastForward size={14} fill="currentColor" strokeWidth={0} />
                          </span>
                        </span>
                        <span className="mc-key">
                          <span className="mc-skip">
                            30
                            <FastForward size={14} fill="currentColor" strokeWidth={0} />
                          </span>
                        </span>
                        <span className="mc-key">
                          <Square size={12} fill="currentColor" strokeWidth={0} />
                        </span>
                      </div>
                    </section>

                    <section className="mc-widget mc-apps">
                      <div className="mc-widget__head">
                        <Bar w={34} h={6} tone={3} />
                        <GripVertical className="mc-grip" size={14} />
                      </div>
                      {[58, 72, 46, 64, 52].map((w, i) => (
                        <div key={i} className="mc-apps__row">
                          <span className="mc-key mc-apps__app">
                            <Bar w={18} h={18} r={5} tone={i === 0 ? 5 : 3} />
                            <Bar w={w} h={6} tone={3} />
                          </span>
                          <span className="mc-key mc-apps__close">
                            <Bar w={26} h={6} tone={3} />
                          </span>
                        </div>
                      ))}
                    </section>

                    <section className="mc-widget mc-keys">
                      <div className="mc-widget__head">
                        <Bar w={30} h={6} tone={3} />
                        <GripVertical className="mc-grip" size={14} />
                      </div>
                      <div className="mc-keys__body">
                        <div className="mc-keys__named">
                          {[30, 36, 40, 32, 34, 26].map((w, i) => (
                            <span key={i} className="mc-key">
                              <Bar w={w} h={6} tone={3} />
                            </span>
                          ))}
                        </div>
                        <div className="mc-dpad">
                          <span className="mc-key mc-dpad__up">
                            <ChevronUp size={16} strokeWidth={2} />
                          </span>
                          <span className="mc-key mc-dpad__left">
                            <ChevronLeft size={16} strokeWidth={2} />
                          </span>
                          <span className="mc-dpad__ok">OK</span>
                          <span className="mc-key mc-dpad__right">
                            <ChevronRight size={16} strokeWidth={2} />
                          </span>
                          <span className="mc-key mc-dpad__down">
                            <ChevronDown size={16} strokeWidth={2} />
                          </span>
                        </div>
                      </div>
                    </section>
                  </div>
                </main>
              </div>
            </div>
          </Window>

          <Phone width={layout === "compact" ? 326 : 300} dark={theme === "dark"} className="mc-hero__phone">
            <div className="mc-phone">
              <div className="mc-phone__bar">
                <span className="mc-brand mc-brand--phone">
                  <BrandIcon size={30} />
                  Media Centre
                </span>
                <Settings size={22} strokeWidth={2} className="mc-phone__cog" />
              </div>

              <Collapse open={s.playing} reveal="drop">
                <section className="mc-widget mc-phone__widget mc-phone__playing">
                  <div className="mc-widget__head">
                    <span className="mc-label">Now playing</span>
                  </div>
                  <div className="mc-phone__film">{FILM}</div>
                  <div className="mc-seek mc-seek--phone">
                    <span className="mc-seek__track">
                      <span className="mc-seek__fill" style={{ width: `${(s.at / LENGTH) * 100}%` }} />
                    </span>
                    <span className="mc-seek__time">
                      <Count value={s.at} format={time} />
                    </span>
                  </div>
                  <div className="mc-phone__keys">
                    <span className="mc-key mc-key--play">
                      <Pause size={22} fill="currentColor" strokeWidth={0} />
                    </span>
                    <span className="mc-key" data-target="stop">
                      <Square size={16} fill="currentColor" strokeWidth={0} />
                    </span>
                  </div>
                </section>
              </Collapse>

              <section className="mc-widget mc-phone__widget">
                <div className="mc-widget__head">
                  <span className="mc-label">Watch &amp; Listen</span>
                </div>
                <div className="mc-crumbs">
                  <span>NAS</span>
                  <ChevronRight size={16} strokeWidth={2} />
                  <strong>Films</strong>
                </div>
                <div className="mc-files">
                  {FILMS.map((f) => (
                    <div
                      key={f.name}
                      className="mc-file"
                      data-target={f.target}
                      data-on={(f.target && s.playing) || undefined}
                    >
                      <span className="mc-file__icon">
                        <Film size={20} strokeWidth={2} />
                      </span>
                      <span className="mc-file__text">
                        <span className="mc-file__name">{f.name}</span>
                        <span className="mc-file__meta">{f.length}</span>
                      </span>
                      {f.target && (
                        <States
                          className="mc-file__state"
                          align="end"
                          value={s.loading ? "loading" : s.playing ? "playing" : "idle"}
                          states={{
                            idle: <Play size={18} strokeWidth={2} />,
                            loading: <Spinner size={18} />,
                            playing: <span className="mc-file__badge">On the TV</span>,
                          }}
                        />
                      )}
                    </div>
                  ))}
                  {[148, 120].map((w, i) => (
                    <div key={i} className="mc-file">
                      <span className="mc-file__icon">
                        <Film size={20} strokeWidth={2} />
                      </span>
                      <span className="mc-file__text mc-file__text--filler">
                        <Text filler className="mc-file__name" w={w} h={8}>
                          Elephants Dream (2006).mkv
                        </Text>
                        <Bar w={34} h={7} tone={2} />
                      </span>
                    </div>
                  ))}
                </div>
              </section>
            </div>
          </Phone>
        </>
      )}
    </Stage>
  );
}
