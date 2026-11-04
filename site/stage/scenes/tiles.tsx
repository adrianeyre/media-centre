import { AirVent, Lightbulb, Minus, Plus, Tv } from "lucide-react";

import { type Act } from "../kit/act.ts";
import { Count } from "../kit/motion/Count.tsx";
import { Stage } from "../kit/stage.tsx";
import "./tiles.css";

// The feature grid's pictures, one Stage per tile, each one thing at real
// size: the Rooms tab's floor plan with a Room picked out (a still), and two
// widgets that each do one small thing once as the grid scrolls in, as a
// supporting grid's tiles do.

type Theme = { theme: "light" | "dark"; still: boolean };

// The page has its own copy of the plan (site/build.ts); the preview takes it
// from docs/images/.
const plan = import.meta.env.DEV
  ? new URL("../../../docs/images/floor-plan.png", import.meta.url).href
  : "images/floor-plan.png";

/** The Rooms tab: the downstairs plan, the Living Room picked out, and what is in it. */
export function RoomsTile({ theme }: Theme) {
  return (
    <Stage
      width={760}
      height={340}
      compact={{ below: 600, width: 358, height: 340 }}
      theme={theme}
      greys="cool"
      className="mc-look mc-tile mc-rooms"
    >
      {() => (
        <>
          <div className="mc-rooms__plan">
            <img src={plan} alt="" draggable={false} />
            <span className="mc-rooms__room" />
            <span className="mc-rooms__name">Living Room</span>
          </div>
          <section className="mc-widget mc-rooms__card">
            <div className="mc-label">Living Room</div>
            {[
              { icon: Tv, name: "TV", state: "Playing a film" },
              { icon: AirVent, name: "Aircon", state: "Cool, set to 21°" },
              { icon: Lightbulb, name: "Floor lamp", state: "On, 30%" },
            ].map(({ icon: Icon, name, state }) => (
              <div key={name} className="mc-rooms__row">
                <span className="mc-rooms__icon">
                  <Icon size={16} strokeWidth={2} />
                </span>
                <span className="mc-rooms__text">
                  <span className="mc-rooms__device">{name}</span>
                  <span className="mc-rooms__state">{state}</span>
                </span>
              </div>
            ))}
          </section>
        </>
      )}
    </Stage>
  );
}

type Aircon = { target: number };

const aircon = async (a: Act<Aircon>) => {
  await a.wait(700);
  for (const target of [22.5, 22, 21.5, 21]) {
    a.put({ target });
    await a.wait(260);
  }
};

const degrees = (n: number) => (Number.isInteger(n) ? `${n}` : n.toFixed(1));

/** The Aircon widget's target temperature, turned down to 21°. */
export function AirconTile({ theme, still }: Theme) {
  return (
    <Stage<Aircon>
      width={372}
      height={208}
      initial={{ target: 23 }}
      poster={{ target: 21 }}
      script={still ? undefined : aircon}
      play="once"
      theme={theme}
      greys="cool"
      className="mc-look mc-tile mc-aircon"
    >
      {(s) => (
        <section className="mc-widget mc-tile__card">
          <div className="mc-label">Living Room · Aircon</div>
          <div className="mc-aircon__status">
            Cool, set to <Count value={s.target} format={degrees} />°
          </div>
          <div className="mc-aircon__modes">
            <span data-on>Cool</span>
            <span>Heat</span>
            <span>Dry</span>
          </div>
          <div className="mc-aircon__target">
            <span className="mc-key">
              <Minus size={16} strokeWidth={2} />
            </span>
            <span className="mc-slider">
              <span className="mc-slider__fill" style={{ width: `${((s.target - 16) / 14) * 100}%` }} />
              <span className="mc-slider__knob" style={{ left: `${((s.target - 16) / 14) * 100}%` }} />
            </span>
            <span className="mc-key">
              <Plus size={16} strokeWidth={2} />
            </span>
            <span className="mc-aircon__value">
              <Count value={s.target} format={degrees} />°
            </span>
          </div>
        </section>
      )}
    </Stage>
  );
}

type Lights = { scene: boolean };

const lights = async (a: Act<Lights>) => {
  await a.wait(900);
  a.put({ scene: true });
};

/** A Room's Light Scenes: Film night recalled, the brightness following it. */
export function LightsTile({ theme, still }: Theme) {
  return (
    <Stage<Lights>
      width={372}
      height={208}
      initial={{ scene: false }}
      poster={{ scene: true }}
      script={still ? undefined : lights}
      play="once"
      theme={theme}
      greys="cool"
      className="mc-look mc-tile mc-lights"
    >
      {(s) => (
        <section className="mc-widget mc-tile__card">
          <div className="mc-label">Living Room Lights</div>
          <div className="mc-lights__scenes">
            <span className="mc-lights__scene" data-on={s.scene || undefined}>
              Film night
            </span>
            <span className="mc-lights__scene">Evening</span>
            <span className="mc-lights__scene">Bright</span>
          </div>
          <div className="mc-lights__label">Brightness</div>
          <div className="mc-aircon__target">
            <span className="mc-slider">
              <span className="mc-slider__fill" style={{ width: s.scene ? "30%" : "70%" }} />
              <span className="mc-slider__knob" style={{ left: s.scene ? "30%" : "70%" }} />
            </span>
            <span className="mc-aircon__value mc-lights__value">
              <Count value={s.scene ? 30 : 70} />%
            </span>
          </div>
        </section>
      )}
    </Stage>
  );
}
