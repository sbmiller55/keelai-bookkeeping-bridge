"use client";

export default function PrivacyPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-2">Keelai Privacy Policy</h1>
        <p className="text-gray-400 mb-8">Last updated: March 22, 2026</p>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">Data We Collect</h2>
          <p className="text-gray-300 leading-relaxed">
            Keelai collects information you provide directly, including your name, email address,
            and account credentials when you register. We also collect financial data you import
            into the platform, including bank transaction records, journal entries, and uploaded
            documents such as invoices and receipts. When you connect third-party services such as
            Mercury Bank or QuickBooks Online, we receive OAuth tokens and the transaction or
            account data those services expose through their APIs. We collect usage data including
            pages visited, features used, and error logs to improve the product.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">How We Use Data</h2>
          <p className="text-gray-300 leading-relaxed">
            We use your data exclusively to provide and improve Keelai's bookkeeping automation
            services. This includes generating AI-assisted journal entries, syncing transactions
            from connected bank accounts, exporting entries to QuickBooks Online, and sending you
            product notifications. We use Anthropic's Claude API to process financial data for
            categorization and coding — data sent to Claude is subject to Anthropic's data
            handling policies. We do not sell your personal or financial data to third parties.
            We do not use your data for advertising purposes.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">Data Storage</h2>
          <p className="text-gray-300 leading-relaxed">
            Your data is stored on secure servers hosted via Railway. Database contents are
            encrypted at rest. OAuth tokens for third-party integrations (Mercury, QuickBooks
            Online) are stored in encrypted form. Uploaded files are stored in server-local
            storage and are accessible only to authenticated users associated with the relevant
            client account. We use HTTPS for all data in transit.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">Data Retention</h2>
          <p className="text-gray-300 leading-relaxed">
            We retain your account data for as long as your account is active. If you cancel your
            account, we will delete your personal data within 30 days upon written request. Certain
            financial records may be retained for up to 7 years to comply with applicable
            accounting and tax record-keeping requirements. You may request an export of your data
            at any time by contacting us at the address below.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">Contact</h2>
          <p className="text-gray-300 leading-relaxed">
            For questions about this privacy policy or to exercise your data rights, contact us at:{" "}
            <a href="mailto:scott@keelai.co" className="text-blue-400 hover:underline">
              scott@keelai.co
            </a>
          </p>
        </section>

        <div className="mt-12 pt-8 border-t border-gray-800">
          <a href="/" className="text-gray-500 hover:text-gray-300 text-sm">
            &larr; Back to Keelai
          </a>
        </div>
      </div>
    </div>
  );
}
