import { ISSUES_URL } from "../about.ts";

/** The Terms and Conditions, shown in their dialog from the footer. */
export const TermsAndConditions = () => (
  <>
    <p class="policy-updated">Effective: 26 October 2026</p>

    <h3>About these terms</h3>
    <p>
      These terms apply when you use Media Centre: the Remote, the Hub and the Player. By using it, you agree to them.
      If you don&rsquo;t agree, please don&rsquo;t use it.
    </p>

    <h3>The licence</h3>
    <p>
      Media Centre is open source under the <strong>ISC licence</strong>. You may use, copy, change and share it, for
      any purpose, with or without a fee, provided the copyright and permission notices are kept with it. The licence
      takes precedence over these terms wherever the two differ.
    </p>

    <h3>Your home, your Appliances and your network</h3>
    <ul>
      <li>
        Use Media Centre only with TVs, Air Conditioners, Lights, heating, Echo and Ring devices that are yours, or that
        you have permission to control.
      </li>
      <li>
        Scan only a network you own or are allowed to scan. The Network tab finds devices by connecting to them, which
        some networks&rsquo; owners forbid.
      </li>
      <li>
        Anyone who can open the Remote on your home network can control everything the Hub controls, as anyone holding a
        TV&rsquo;s own remote can. Keep your network to people you trust, and never make the Hub reachable from the
        internet.
      </li>
      <li>You are responsible for the media you play with Media Centre, and for having the right to play it.</li>
    </ul>

    <h3>Other companies&rsquo; products and services</h3>
    <ul>
      <li>
        Media Centre isn&rsquo;t made, endorsed or supported by Samsung, Midea, Lepro, Hive, Amazon or Ring, or the
        maker of any other device it controls. Their names are used only to say what Media Centre works with, and their
        trademarks are their own.
      </li>
      <li>
        Hive, Amazon and Ring are reached through their own clouds, and Amazon and Ring through the private interfaces
        their own apps use, which neither company offers to others. When you connect one, you remain bound by its own
        terms, and it may change or withdraw what Media Centre relies on at any time, or limit an account it sees using
        them. Connect one only if you accept that.
      </li>
      <li>
        A maker&rsquo;s firmware update may change how its device is controlled, and some features may then stop working
        until Media Centre catches up.
      </li>
    </ul>

    <h3>Heating and air conditioning</h3>
    <p>
      Media Centre changes temperatures, schedules and modes as you ask, but it is not a safety device. Keep your
      heating&rsquo;s own controls, frost protection and any thermostat a vulnerable person relies on in place, and
      check that a change has taken effect where it matters.
    </p>

    <h3>No warranty</h3>
    <p>
      Media Centre is provided <strong>&ldquo;as is&rdquo;</strong>, without warranty of any kind, as the licence says.
      We can&rsquo;t promise that it is free of faults, that it will keep working with every device or service, or that
      every model will take every command.
    </p>

    <h3>Limitation of liability</h3>
    <p>
      To the extent the law allows, the authors of Media Centre are not liable for any loss or damage that comes from
      using it, or from being unable to. Nothing in these terms limits a liability that the law does not allow to be
      limited, or affects your rights as a consumer.
    </p>

    <h3>Governing law</h3>
    <p>
      These terms are governed by the law of England and Wales. If you live elsewhere in the United Kingdom or the
      European Union, you also keep the protection of your own country&rsquo;s mandatory laws.
    </p>

    <h3>Changes to these terms</h3>
    <p>
      If these terms change, the new terms will be shown here, with a new effective date, in the release that brings
      them.
    </p>

    <h3>Contact us</h3>
    <p>
      If you have a question about these terms, please{" "}
      <a href={ISSUES_URL} target="_blank" rel="noopener noreferrer">
        open an issue on GitHub (opens in a new tab)
      </a>
      .
    </p>
  </>
);
