"use client";

export default function TermsPage() {
  return (
    <div className="min-h-screen bg-gray-950 text-white">
      <div className="max-w-2xl mx-auto p-8">
        <h1 className="text-3xl font-bold mb-2">Keelai Terms of Service</h1>
        <p className="text-gray-400 mb-8">Last updated: March 22, 2026</p>

        <p className="text-gray-300 leading-relaxed mb-8">
          Please read these Terms of Service carefully before using Keelai. By accessing or using
          the platform, you agree to be bound by these terms. If you do not agree, do not use the
          service.
        </p>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">License</h2>
          <p className="text-gray-300 leading-relaxed">
            Subject to your compliance with these terms and payment of applicable fees, Keelai
            grants you a limited, non-exclusive, non-transferable, revocable license to access and
            use the platform for your internal business bookkeeping purposes. This license does not
            include the right to sublicense, resell, or redistribute the service. All intellectual
            property in the platform, including the software, AI models, and UI, remain the
            exclusive property of Keelai.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">Restrictions</h2>
          <p className="text-gray-300 leading-relaxed mb-3">You agree not to:</p>
          <ul className="text-gray-300 leading-relaxed list-disc list-inside space-y-1">
            <li>Use the platform for any unlawful purpose or in violation of any regulations</li>
            <li>Reverse engineer, decompile, or attempt to extract the source code of the platform</li>
            <li>Use the platform to process data on behalf of third parties in a resale or bureau capacity without written authorization</li>
            <li>Attempt to gain unauthorized access to any systems or data</li>
            <li>Upload malicious code, viruses, or any content intended to damage the platform or other users</li>
            <li>Use automated means to scrape or harvest data from the platform beyond normal API usage</li>
          </ul>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">Disclaimer</h2>
          <p className="text-gray-300 leading-relaxed mb-3">
            Keelai is a bookkeeping automation tool and does not provide accounting, tax, legal, or
            financial advice. AI-generated journal entries and categorizations are suggestions only
            and must be reviewed by a qualified accounting professional before reliance. You are
            solely responsible for the accuracy of your financial records and for compliance with
            applicable tax and accounting standards.
          </p>
          <p className="text-gray-300 leading-relaxed mb-3">
            THE PLATFORM IS PROVIDED "AS IS" WITHOUT WARRANTY OF ANY KIND, EXPRESS OR IMPLIED,
            INCLUDING WARRANTIES OF MERCHANTABILITY, FITNESS FOR A PARTICULAR PURPOSE, OR
            NON-INFRINGEMENT. KEELAI DOES NOT WARRANT THAT THE SERVICE WILL BE UNINTERRUPTED,
            ERROR-FREE, OR THAT DEFECTS WILL BE CORRECTED.
          </p>
          <p className="text-gray-300 leading-relaxed">
            IN NO EVENT SHALL KEELAI BE LIABLE FOR ANY INDIRECT, INCIDENTAL, SPECIAL, CONSEQUENTIAL,
            OR PUNITIVE DAMAGES ARISING FROM YOUR USE OF THE PLATFORM, EVEN IF ADVISED OF THE
            POSSIBILITY OF SUCH DAMAGES. KEELAI'S TOTAL LIABILITY SHALL NOT EXCEED THE AMOUNTS
            PAID BY YOU IN THE TWELVE MONTHS PRECEDING THE CLAIM.
          </p>
        </section>

        <section className="mb-8">
          <h2 className="text-xl font-semibold mb-3 text-gray-100">Contact</h2>
          <p className="text-gray-300 leading-relaxed">
            For questions about these Terms of Service, contact us at:{" "}
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
