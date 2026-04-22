import Link from "next/link";

export const metadata = {
  title: "Privacy Policy · Ronny J Ops",
  description:
    "How Ronny J Listen UP LLC and 17hertz collect, use, and protect information processed through the Ronny J Ops system.",
};

export default function PrivacyPage() {
  return (
    <main className="mx-auto max-w-3xl px-8 py-20">
      <Link
        href="/"
        className="font-mono text-xs uppercase tracking-[0.3em] text-neutral-500 transition hover:text-brand"
      >
        ← Ronny J Ops
      </Link>

      <p className="mt-10 font-mono text-xs uppercase tracking-[0.3em] text-brand">
        Legal
      </p>
      <h1 className="mt-4 font-display text-5xl leading-tight">
        Privacy <span className="italic text-brand">policy</span>
      </h1>
      <p className="mt-4 text-sm text-neutral-500">
        Effective date: April 22, 2026
      </p>

      <div className="mt-12 text-neutral-300 [&_a]:text-brand [&_a]:underline [&_a:hover]:text-white [&_strong]:text-neutral-100 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6 [&_li]:marker:text-neutral-600">
        <Section title="Who we are">
          <p>
            The Ronny J Ops system (the &ldquo;Service&rdquo;) is operated at{" "}
            <span className="text-neutral-100">ronnyj.17hertz.com</span> on
            behalf of <strong>Ronny J Listen UP LLC</strong> (a Florida limited
            liability company), which is the data controller and the party
            responsible for the business relationship with recipients of
            communications sent through the Service.
          </p>
          <p>
            <strong>17hertz Inc.</strong> is the operator and acts as a service
            provider / data processor on behalf of Ronny J Listen UP LLC. Where
            this policy says &ldquo;we&rdquo; or &ldquo;us,&rdquo; it refers to
            both entities in their respective roles.
          </p>
          <p>
            Contact: <a href="mailto:jason@17hertz.io">jason@17hertz.io</a>
          </p>
        </Section>

        <Section title="What information we collect">
          <p>We collect the following categories of information:</p>
          <ul>
            <li>
              <strong>Contact information</strong> &mdash; names, mobile phone
              numbers, email addresses, and preferred messaging channel for
              people who appear on the team calendar or are being notified of
              appointments.
            </li>
            <li>
              <strong>Consent records</strong> &mdash; timestamp, source, and
              IP address of the moment you opted in to receive SMS, WhatsApp,
              or email messages from us, and any subsequent opt-out.
            </li>
            <li>
              <strong>Vendor information</strong> &mdash; for businesses or
              individuals submitting invoices through the vendor portal:
              business name, contact details, W-9 information (legal name,
              business classification, address, and Taxpayer Identification
              Number), uploaded invoices, and payment-routing details supplied
              by the vendor.
            </li>
            <li>
              <strong>Calendar and task data</strong> &mdash; events, tasks,
              attendees, and notes synced from Google Calendar for users who
              have connected their Google account, and data entered directly
              into the team dashboard.
            </li>
            <li>
              <strong>Authentication data</strong> &mdash; email address used
              for team sign-in, and OAuth tokens returned by Google for
              calendar-connected users. We do not see or store Google
              passwords.
            </li>
            <li>
              <strong>Message delivery data</strong> &mdash; the content of
              reminders we send, the delivery status returned by Twilio or
              Resend, and any reply messages (e.g., STOP, HELP, or appointment
              confirmations).
            </li>
            <li>
              <strong>Technical data</strong> &mdash; standard server logs
              (IP address, user agent, timestamp, request path) retained for a
              limited period for abuse prevention and debugging.
            </li>
          </ul>
        </Section>

        <Section title="How we use this information">
          <p>We use the information above only to:</p>
          <ul>
            <li>
              Send you the communications you asked for &mdash; appointment
              reminders, vendor status updates, team notifications.
            </li>
            <li>
              Maintain the team task list, today&apos;s schedule, and the
              reminder queue for authenticated team members.
            </li>
            <li>
              Process vendor intake submissions, verify W-9 data, and produce
              year-end 1099 reporting for Ronny J Listen UP LLC.
            </li>
            <li>
              Respond to opt-in, opt-out, and support requests.
            </li>
            <li>
              Detect abuse, prevent unauthorized access, and comply with
              applicable law.
            </li>
          </ul>
          <p>
            We do <strong>not</strong> sell personal information, we do{" "}
            <strong>not</strong> use it for behavioral advertising, and we do{" "}
            <strong>not</strong> share mobile opt-in data or phone numbers with
            third parties or affiliates for their own marketing purposes.
          </p>
        </Section>

        <Section title="SMS, WhatsApp, and messaging (TCPA)">
          <p>
            Message frequency varies based on your relationship with Ronny J
            Listen UP LLC. Typical volume is a 24-hour and 1-hour reminder per
            scheduled appointment, plus transactional confirmations.
            Message-and-data rates may apply. Carriers are not liable for
            delayed or undelivered messages.
          </p>
          <p>
            Reply <strong>STOP</strong> at any time to opt out of further SMS
            messages. Reply <strong>HELP</strong> for help. You can also opt
            out by emailing <a href="mailto:jason@17hertz.io">jason@17hertz.io</a>{" "}
            with the phrase &ldquo;unsubscribe&rdquo; and the phone number you
            want removed. Opt-outs are processed promptly and are honored
            across every messaging channel (SMS, WhatsApp, RCS) for the number
            or address you identified.
          </p>
          <p>
            We record the date, time, and source of every opt-in so that we can
            honor our obligations under the Telephone Consumer Protection Act
            (TCPA) and carrier Codes of Conduct. Opt-in is always on an
            individual basis &mdash; we do not purchase, rent, or trade phone
            lists.
          </p>
        </Section>

        <Section title="Email (CAN-SPAM)">
          <p>
            Every email we send includes a working unsubscribe link and the
            physical mailing address of Ronny J Listen UP LLC. Clicking the
            unsubscribe link removes your address from all non-transactional
            email within ten business days. Certain transactional messages
            (e.g., &ldquo;we received your invoice&rdquo;) may still be sent
            after unsubscribe if you have an active vendor engagement; those
            messages will not contain marketing content.
          </p>
        </Section>

        <Section title="W-9 and tax identification data">
          <p>
            When vendors submit a W-9 through the portal, we collect the full
            Taxpayer Identification Number (SSN for individuals, EIN for
            entities). Full TINs are encrypted at rest using column-level
            encryption in our Supabase/Postgres database. Only the last four
            digits are available in plaintext to authorized team members for
            verification; decryption of the full TIN is limited to the
            automated 1099 preparation process and to the finance contact of
            record.
          </p>
          <p>
            Uploaded W-9 forms and invoices are stored in a private,
            access-controlled storage bucket. We retain W-9 records for four
            (4) years from the date of the last payment, per IRS guidance, and
            then delete them.
          </p>
        </Section>

        <Section title="Third-party processors">
          <p>
            We rely on the following sub-processors to operate the Service.
            Each processes data only on our documented instructions and under
            a data processing agreement:
          </p>
          <ul>
            <li>
              <strong>Supabase</strong> &mdash; primary database, authentication,
              and encrypted file storage.
            </li>
            <li>
              <strong>Twilio</strong> &mdash; SMS, WhatsApp, and RCS delivery,
              including carrier status callbacks.
            </li>
            <li>
              <strong>Resend</strong> &mdash; transactional email delivery.
            </li>
            <li>
              <strong>Google</strong> &mdash; Google Calendar and People APIs,
              used only for users who have explicitly connected their Google
              account.
            </li>
            <li>
              <strong>Inngest</strong> &mdash; durable job scheduling for
              reminders.
            </li>
            <li>
              <strong>Vercel</strong> &mdash; application hosting, including
              standard server logs.
            </li>
            <li>
              <strong>Anthropic</strong> &mdash; the Claude Agent SDK that
              powers automation actions inside the team dashboard. Message
              contents processed by the agent may transit Anthropic&apos;s
              infrastructure subject to its{" "}
              <a
                href="https://www.anthropic.com/legal/commercial-terms"
                target="_blank"
                rel="noreferrer"
              >
                commercial terms
              </a>
              . We do not send Anthropic W-9 data, full TINs, or passwords.
            </li>
          </ul>
        </Section>

        <Section title="Google API data use">
          <p>
            The Service&apos;s use and transfer of information received from
            Google APIs adheres to the{" "}
            <a
              href="https://developers.google.com/terms/api-services-user-data-policy"
              target="_blank"
              rel="noreferrer"
            >
              Google API Services User Data Policy
            </a>
            , including the Limited Use requirements. Google Calendar event
            data is used solely to power reminders and the team schedule view.
            We do not use Google data to train machine learning models and do
            not transfer it to third parties except the sub-processors listed
            above as strictly necessary to provide the Service.
          </p>
        </Section>

        <Section title="Retention">
          <p>
            We retain contact and calendar data for as long as the underlying
            business relationship is active, and for a reasonable tail
            afterward for audit and dispute-resolution purposes. Specifically:
            W-9 and invoice records for four (4) years; SMS and email delivery
            logs for two (2) years; server logs for ninety (90) days; opt-in
            and opt-out consent records indefinitely, so we can prove TCPA
            compliance.
          </p>
        </Section>

        <Section title="Your rights">
          <p>
            You can request a copy of the information we hold about you,
            correction of inaccurate data, deletion of data we no longer need
            for a lawful purpose, and opt-out of messaging at any time. Send
            requests to <a href="mailto:jason@17hertz.io">jason@17hertz.io</a>{" "}
            from the email address on file (or include the phone number on
            file). We respond within thirty (30) days. Residents of
            California, Virginia, Colorado, Connecticut, and other states with
            consumer-privacy statutes have additional rights under those laws
            and may exercise them through the same contact address.
          </p>
        </Section>

        <Section title="Security">
          <p>
            Data is encrypted in transit (TLS 1.2+) and at rest. Access to
            production systems is limited to named team members using
            multi-factor authentication. The service-role database key is
            stored only in server-side environments and never reaches the
            browser. We review access regularly and revoke it when a team
            member departs.
          </p>
          <p>
            No system is perfectly secure. If you believe your data has been
            compromised, contact{" "}
            <a href="mailto:jason@17hertz.io">jason@17hertz.io</a> immediately.
          </p>
        </Section>

        <Section title="Children">
          <p>
            The Service is intended for business use by adults. We do not
            knowingly collect information from children under 13. If you
            believe a minor has provided information, contact us and we will
            delete it.
          </p>
        </Section>

        <Section title="Changes to this policy">
          <p>
            We may update this policy as the Service evolves. Material changes
            will be communicated via email to active team members and vendors,
            and the effective date above will be updated.
          </p>
        </Section>

        <Section title="Contact">
          <p>
            Ronny J Listen UP LLC
            <br />
            c/o 17hertz Inc.
            <br />
            Email:{" "}
            <a href="mailto:jason@17hertz.io">jason@17hertz.io</a>
          </p>
        </Section>
      </div>

      <p className="mt-16 text-xs text-neutral-600">
        Built for Ronny J · 2026
      </p>
    </main>
  );
}

function Section({
  title,
  children,
}: {
  title: string;
  children: React.ReactNode;
}) {
  return (
    <section className="mt-10">
      <h2 className="font-display text-2xl text-neutral-100">{title}</h2>
      <div className="mt-3 space-y-3 text-[15px] leading-relaxed text-neutral-300">
        {children}
      </div>
    </section>
  );
}
