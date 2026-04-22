import Link from "next/link";

export const metadata = {
  title: "Terms of Service · Ronny J Ops",
  description:
    "Terms governing use of the Ronny J Ops vendor portal and team dashboard, operated by 17hertz on behalf of Ronny J Listen UP LLC.",
};

export default function TermsPage() {
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
        Terms of <span className="italic text-brand">service</span>
      </h1>
      <p className="mt-4 text-sm text-neutral-500">
        Effective date: April 22, 2026
      </p>

      <div className="mt-12 text-neutral-300 [&_a]:text-brand [&_a]:underline [&_a:hover]:text-white [&_strong]:text-neutral-100 [&_ul]:mt-2 [&_ul]:list-disc [&_ul]:space-y-1.5 [&_ul]:pl-6 [&_li]:marker:text-neutral-600">
        <Section title="1. Who this agreement is with">
          <p>
            These Terms govern your use of the Ronny J Ops system at{" "}
            <span className="text-neutral-100">ronnyj.17hertz.com</span> and
            any associated subdomains (the &ldquo;Service&rdquo;). The Service
            is owned by <strong>Ronny J Listen UP LLC</strong> (a Florida
            limited liability company) and operated on its behalf by{" "}
            <strong>17 Hertz Inc.</strong> (a Nevada corporation). In these
            Terms, &ldquo;we&rdquo; and
            &ldquo;us&rdquo; refer to those two entities together;
            &ldquo;you&rdquo; refers to the person or business accessing the
            Service.
          </p>
          <p>
            By using the Service &mdash; including submitting a vendor intake
            form, signing in to the team dashboard, or receiving messages
            through the Service &mdash; you agree to these Terms and to our{" "}
            <Link href="/privacy" className="text-brand hover:underline">
              Privacy Policy
            </Link>
            .
          </p>
        </Section>

        <Section title="2. Accounts and access">
          <p>
            Access to the team dashboard is by invitation only. If you are a
            team member or authorized contractor of Ronny J Listen UP LLC, you
            agree to:
          </p>
          <ul>
            <li>Keep your login credentials confidential.</li>
            <li>
              Use multi-factor authentication where offered, and notify us
              promptly if you suspect unauthorized access.
            </li>
            <li>
              Access only the data you need for the work assigned to you.
            </li>
            <li>
              Not share sensitive contact or vendor data with anyone outside
              the team, and not export data from the Service except for
              legitimate business purposes.
            </li>
          </ul>
          <p>
            We may suspend or revoke access at any time if we reasonably
            believe these Terms have been violated, or if your role no longer
            requires it.
          </p>
        </Section>

        <Section title="3. Vendor portal">
          <p>
            The vendor intake portal allows you to submit tax and payment
            information, upload invoices, and track the status of payments. By
            submitting information through the portal, you represent and
            warrant that:
          </p>
          <ul>
            <li>
              All information you provide &mdash; including your legal business
              name, Taxpayer Identification Number (TIN), mailing address, and
              payment routing details &mdash; is accurate and current.
            </li>
            <li>
              The W-9 information you submit is the correct, signed W-9 for
              the entity that will be paid, and you are authorized to submit
              it on that entity&apos;s behalf.
            </li>
            <li>
              Every invoice you upload reflects goods or services actually
              provided, at the rates that were agreed to with Ronny J Listen
              UP LLC or its authorized representatives.
            </li>
            <li>
              You will promptly correct any errors you discover and notify us
              of changes to your legal name, TIN, or payment details.
            </li>
          </ul>
          <p>
            Submitting an invoice through the portal is a request for payment;
            it is not an acceptance by us. Payment is subject to verification,
            applicable holdbacks, and the payment terms negotiated separately.
            We may reject or return invoices that appear inaccurate,
            duplicative, or non-compliant.
          </p>
        </Section>

        <Section title="4. Messaging consent (SMS, WhatsApp, email)">
          <p>
            If you opt in to receive messages from us (for example, by
            entering your mobile number in the intake form or the dashboard),
            you consent to receive automated transactional and service
            messages related to your engagement with Ronny J Listen UP LLC.
            Message frequency varies; typical messages include appointment
            reminders and vendor status updates. Message-and-data rates may
            apply.
          </p>
          <p>
            You can revoke consent at any time. Reply <strong>STOP</strong> to
            any SMS or WhatsApp message to opt out of that channel, or email{" "}
            <a href="mailto:jason@17hertz.io">jason@17hertz.io</a> to opt out
            of email. Opt-outs do not terminate your underlying business
            relationship with Ronny J Listen UP LLC.
          </p>
        </Section>

        <Section title="5. Acceptable use">
          <p>You agree not to use the Service to:</p>
          <ul>
            <li>
              Violate any law, regulation, or third-party right (including
              intellectual property and privacy rights).
            </li>
            <li>
              Upload or transmit viruses, malicious code, or content that is
              defamatory, harassing, or unlawful.
            </li>
            <li>
              Attempt to gain unauthorized access to the Service, any other
              user&apos;s account, or the underlying infrastructure (including
              Supabase, Twilio, Resend, Google, Inngest, Vercel, or
              Anthropic).
            </li>
            <li>
              Probe, scan, or test the vulnerability of the Service without
              written permission.
            </li>
            <li>
              Interfere with the operation of the Service or the messaging
              delivery of other users.
            </li>
            <li>
              Submit information that you know to be false, including forged
              W-9s or invoices for goods or services not actually provided.
            </li>
          </ul>
        </Section>

        <Section title="6. Intellectual property">
          <p>
            The Service, including its source code, interface, copy, and
            design, is the intellectual property of 17 Hertz Inc. and Ronny J
            Listen UP LLC. You receive only a limited, revocable,
            non-transferable license to use the Service for its intended
            purpose. You may not copy, reverse-engineer, or build competing
            services based on the Service.
          </p>
          <p>
            Information you upload &mdash; invoices, W-9s, calendar data, task
            notes &mdash; remains yours or your organization&apos;s. You grant
            us the license required to store, process, transmit, and display
            that information for the purposes described in the Privacy Policy.
          </p>
        </Section>

        <Section title="7. Third-party services">
          <p>
            The Service relies on third-party providers, including Supabase,
            Twilio, Resend, Google, Inngest, Vercel, and Anthropic. Those
            providers operate under their own terms and availability
            commitments. Outages or changes at a provider may temporarily
            affect the Service; we are not responsible for those upstream
            events beyond using reasonable efforts to route around them.
          </p>
        </Section>

        <Section title="8. Disclaimers">
          <p>
            THE SERVICE IS PROVIDED &ldquo;AS IS&rdquo; AND &ldquo;AS
            AVAILABLE,&rdquo; WITHOUT WARRANTIES OF ANY KIND, EXPRESS OR
            IMPLIED, INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A
            PARTICULAR PURPOSE, AND NON-INFRINGEMENT. WE DO NOT WARRANT THAT
            MESSAGE DELIVERY WILL BE UNINTERRUPTED OR ERROR-FREE, THAT
            REMINDERS WILL ARRIVE AT A PARTICULAR TIME, OR THAT CALENDAR SYNC
            WILL REFLECT CHANGES INSTANTLY. YOU ARE RESPONSIBLE FOR
            INDEPENDENTLY CONFIRMING ANY APPOINTMENT OR PAYMENT BEFORE ACTING
            ON IT.
          </p>
        </Section>

        <Section title="9. Limitation of liability">
          <p>
            TO THE MAXIMUM EXTENT PERMITTED BY LAW, NEITHER RONNY J LISTEN UP
            LLC NOR 17HERTZ INC. WILL BE LIABLE FOR ANY INDIRECT, INCIDENTAL,
            CONSEQUENTIAL, SPECIAL, OR PUNITIVE DAMAGES, OR ANY LOSS OF
            PROFITS, REVENUES, DATA, OR GOODWILL, ARISING OUT OF OR RELATED TO
            YOUR USE OF THE SERVICE. OUR AGGREGATE LIABILITY FOR ANY CLAIM
            RELATED TO THE SERVICE IS LIMITED TO THE GREATER OF ONE HUNDRED US
            DOLLARS ($100) OR THE AMOUNTS PAID TO YOU BY RONNY J LISTEN UP LLC
            UNDER THE SEPARATE AGREEMENT THAT GIVES RISE TO THE CLAIM IN THE
            TWELVE MONTHS PRECEDING IT.
          </p>
        </Section>

        <Section title="10. Indemnification">
          <p>
            You agree to defend, indemnify, and hold harmless Ronny J Listen
            UP LLC, 17 Hertz Inc., and their officers, employees, and agents
            from any claim, loss, or expense (including reasonable
            attorneys&apos; fees) arising from: (a) your breach of these
            Terms, (b) your submission of inaccurate W-9 or invoice data, or
            (c) your violation of any law or third-party right in connection
            with the Service.
          </p>
        </Section>

        <Section title="11. Termination">
          <p>
            We may suspend or terminate your access to the Service at any time
            if we believe you have violated these Terms, if continuing to
            provide the Service to you would expose us to legal risk, or if we
            discontinue the Service. You may stop using the Service at any
            time. Sections that by their nature should survive termination
            (including Intellectual Property, Disclaimers, Limitation of
            Liability, Indemnification, and Governing Law) will survive.
          </p>
        </Section>

        <Section title="12. Governing law and disputes">
          <p>
            These Terms are governed by the laws of the State of Florida,
            without regard to conflict-of-laws rules. The exclusive venue for
            any dispute that is not subject to arbitration is the state and
            federal courts located in Miami-Dade County, Florida, and you
            consent to personal jurisdiction there. Nothing in these Terms
            waives any non-waivable statutory right you may have under
            applicable consumer-protection law.
          </p>
        </Section>

        <Section title="13. Changes to these Terms">
          <p>
            We may update these Terms as the Service evolves. Material changes
            will be communicated to active team members and registered vendors
            via email, and the effective date above will be updated. Continued
            use of the Service after an update constitutes acceptance of the
            revised Terms.
          </p>
        </Section>

        <Section title="14. Contact">
          <p>
            Questions about these Terms can be directed to:
          </p>
          <p>
            Ronny J Listen UP LLC
            <br />
            c/o 17 Hertz Inc.
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
