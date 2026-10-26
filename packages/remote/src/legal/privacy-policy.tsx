import { ISSUES_URL } from "../about.ts";
import { Icon } from "../icons.tsx";

/** Every service outside the home that Media Centre can talk to, when, and what it sends. */
const SERVICES = [
  {
    name: "GitHub",
    when: "As a Remote opens, at most once an hour",
    sent: "A request for media-centre's latest version number. Nothing about you or your home.",
  },
  {
    name: "Midea",
    when: "Once, when you add an Air Conditioner that needs a token",
    sent: "The MSmartHome or Midea Air login you type, and the unit's id. The Hub keeps the token and key it gets back, and forgets the login.",
  },
  {
    name: "Hive",
    when: "From when you sign in to Hive in Settings until you sign out",
    sent: "Your Hive login, once, to Hive's sign-in service on Amazon Web Services. Then the tokens Hive issues, to read and change your heating and hot water.",
  },
  {
    name: "Amazon",
    when: "From when you sign in on the Amazon tab until you sign out",
    sent: "You sign in on Amazon's own page, so the Hub never sees your password. Then the session Amazon issues, to read and control your Echo devices. The Remote shows cover art from Amazon's image servers.",
  },
  {
    name: "Ring",
    when: "From when you sign in on the Ring tab until you sign out",
    sent: "Your Ring email, password and two-step code, once. Then the token Ring issues, for snapshots, events, recordings and live video, which comes straight from Ring to the Remote.",
  },
  {
    name: "Google",
    when: "Only while you watch a Ring device live",
    sent: "The Remote asks Google's public STUN server for its internet address, to set up the live video. Google sees that address and nothing else.",
  },
] as const;

/** The Privacy Policy, shown in its dialog from the footer. */
export const PrivacyPolicy = () => (
  <>
    <p class="policy-updated">Effective: 26 October 2026</p>

    <div class="status-box">
      <Icon name="shield-check" />
      <p>
        <strong>In short:</strong> Media Centre runs on your own Hub, in your own home. There is no Media Centre
        account, no analytics and no advertising, and its authors never receive anything about you. Your data leaves
        your home only for the services you choose to connect, such as Hive, Amazon or Ring.
      </p>
    </div>

    <h3>About this policy</h3>
    <p>
      Media Centre is open-source software that you run yourself: the Remote you are using now, the Hub on your home
      network that serves it, and the Player on your TVs. No company runs it for you, and it sends nothing to its
      authors. This policy explains what Media Centre keeps and where, what reaches the internet and why, and how you
      stay in control. &ldquo;We&rdquo; means media-centre&rsquo;s authors; &ldquo;you&rdquo; means whoever runs the Hub
      and the people in their home who use it.
    </p>

    <h3>Who is responsible for your data</h3>
    <p>
      The Hub and everything it keeps are yours, on a machine you control, so you decide what is kept and for how long.
      Each service you connect, such as Hive, Amazon or Ring, is responsible for what it receives, under its own privacy
      policy.
    </p>

    <h3>What the Hub keeps</h3>
    <p>The Hub keeps its state in one database file, on the PC or NAS it runs on:</p>
    <ul>
      <li>
        <strong>Your home</strong>: your Rooms, their order, and your floor plan, with the drawing you upload and which
        Room each place on it is.
      </li>
      <li>
        <strong>Your Appliances</strong>: each TV, Air Conditioner and Light, with the name and Room you give it and
        what it reports of itself, such as its model, serial number, IP address and MAC address, so the Hub can find it
        and switch it on. Also your Light Scenes, and each TV&rsquo;s film Light Scene.
      </li>
      <li>
        <strong>Keys to your Appliances</strong>: the pairing token each TV gives the Hub when you choose Allow on it,
        and each Air Conditioner&rsquo;s token and key from Midea.
      </li>
      <li>
        <strong>Sign-ins</strong>: the tokens Hive issues, the session Amazon issues and the token Ring issues, while
        you are signed in to each. Never your Hive, Amazon or Ring password.
      </li>
      <li>
        <strong>Your network</strong>: the last scan of your home network, with each device&rsquo;s IP address, MAC
        address, maker, network name and open ports, and the last Bluetooth scan, with what each device near the Hub
        advertises. Also the name and Room you give any device.
      </li>
      <li>
        <strong>Your media</strong>: the folders you add as Media Sources, what the Hub has read of each Media File,
        such as its length and tracks, and where you stopped each one, so that it can resume.
      </li>
      <li>
        <strong>The Player&rsquo;s signing certificate</strong>, if you upload one: Samsung&rsquo;s author and
        distributor certificates and their passwords, which the Hub needs to install the Player on your TVs.
      </li>
      <li>
        <strong>The Hub itself</strong>: a random id, when it was set up, and the address you set for it, if any.
      </li>
    </ul>
    <p>
      The Hub never writes a password, token, key or session to its logs, and keeps a password you type only for as long
      as it takes to sign in.
    </p>

    <h3>What this browser keeps</h3>
    <p>
      Each phone, tablet or computer keeps its own preferences, such as its last tab, its Selected TV, its theme and how
      its widgets are laid out, in the browser&rsquo;s local storage. The Cookie Policy lists every item.
    </p>

    <h3>What stays in your home</h3>
    <p>
      Controlling your TVs, Air Conditioners and Lights, scanning your network, listening for Bluetooth devices, and
      playing your films, shows and music all happen on your home network alone, and keep working with the internet
      disconnected.
    </p>

    <h3>What leaves your home network</h3>
    <p>
      Only the following, and, apart from the version check, only once you connect the service yourself. Each service
      also sees your home&rsquo;s internet address.
    </p>
    {/* Wider than a phone, so it scrolls across on its own, rather than the whole page. */}
    <div class="table-scroll" tabIndex={0} role="region" aria-labelledby="services-table-caption">
      <table>
        <caption id="services-table-caption">Every service outside your home that Media Centre can contact.</caption>
        <thead>
          <tr>
            <th scope="col">Service</th>
            <th scope="col">When</th>
            <th scope="col">What is sent</th>
          </tr>
        </thead>
        <tbody>
          {SERVICES.map((service) => (
            <tr key={service.name}>
              <th scope="row">{service.name}</th>
              <td>{service.when}</td>
              <td>{service.sent}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
    <p>
      Following a link to GitHub, from this footer, the Changelog or an update, opens GitHub&rsquo;s own site, under its
      own privacy statement. The Remote loads no third-party fonts, scripts or trackers.
    </p>

    <h3>What we don&rsquo;t do</h3>
    <ul>
      <li>We don&rsquo;t collect, sell, rent or share your personal data. We never receive it.</li>
      <li>There is no analytics, telemetry, crash reporting, profiling, tracking or advertising.</li>
      <li>There is no Media Centre account, and we never ask for your name or email address.</li>
    </ul>

    <h3>Keeping it safe</h3>
    <ul>
      <li>
        The Remote has no sign-in of its own: anyone who can open it on your home network can use it, as anyone holding
        a TV&rsquo;s own remote can. Keep your Wi-Fi to people you trust, and never make the Hub reachable from the
        internet.
      </li>
      <li>
        The Hub&rsquo;s database file holds the keys to your Appliances and your sign-ins. Keep it, and any backup of
        it, as safe as you would a password.
      </li>
    </ul>

    <h3>Your choices</h3>
    <ul>
      <li>Remove an Appliance, a Light Scene or a Room in Settings, and the Hub forgets it.</li>
      <li>
        Sign out of Hive in Settings, or of Amazon or Ring on their tabs, and the Hub forgets that sign-in. You can also
        end the Hub&rsquo;s session from each service&rsquo;s own account settings.
      </li>
      <li>Remove a Media Source in Settings, and the Hub forgets its files and where you stopped them.</li>
      <li>Clear this browser&rsquo;s storage in its settings, and this Remote forgets its preferences.</li>
      <li>
        Delete the Hub&rsquo;s database file, or its Docker volume, and everything it kept is gone. To stop a TV letting
        the Hub in, remove the Hub from the TV&rsquo;s list of connected devices.
      </li>
    </ul>

    <h3>Children</h3>
    <p>
      Media Centre is a household tool, not a service aimed at children, and it collects nothing from anyone, children
      included.
    </p>

    <h3>Changes to this policy</h3>
    <p>
      If Media Centre changes what it keeps or where it sends anything, this policy changes with it, in the same
      release, with a new effective date.
    </p>

    <h3>Contact us</h3>
    <p>
      If you have a question about this policy, please{" "}
      <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
        open an issue on GitHub (opens in a new tab)
      </a>
      . Issues are public, so please leave out any personal details.
    </p>
  </>
);
