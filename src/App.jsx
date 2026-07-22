import { useState } from "react";
import heroImage from "./assets/afterschoolpay-hero.png";
import "./App.css";

const benefits = [
  {
    title: "Collect from every family",
    text: "Accept program fees, drop-in charges, late pickup fees, and reimbursements without chasing separate spreadsheets.",
  },
  {
    title: "Know every balance",
    text: "Give staff a live view of paid, pending, waived, and overdue balances before pickup gets busy.",
  },
  {
    title: "Close the week faster",
    text: "Reconcile payments, attendance, and payouts in one place so program directors can move on.",
  },
];

const workflows = [
  "Send payment requests after enrollment or attendance updates.",
  "Let parents pay from a secure link on mobile or desktop.",
  "Track balances by student, family, program, and school site.",
  "Export clean records for accounting and subsidy reporting.",
];

function App() {
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    role: "Program owner",
  });
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  const handleChange = (event) => {
    const { name, value } = event.target;
    setFormData((current) => ({
      ...current,
      [name]: value,
    }));
  };

  const handleSubmit = async (event) => {
    event.preventDefault();

    if (!formData.email.trim()) {
      setStatus("error");
      setMessage("Add an email address so we know where to send access.");
      return;
    }

    setStatus("loading");
    setMessage("");

    try {
      const [{ addDoc, collection, serverTimestamp }, { firestore }] =
        await Promise.all([
          import("firebase/firestore/lite"),
          import("./lib/firebase"),
        ]);

      await addDoc(collection(firestore, "earlyAccessLeads"), {
        name: formData.name.trim(),
        email: formData.email.trim().toLowerCase(),
        role: formData.role,
        source: "afterschoolpay-landing-page",
        createdAt: serverTimestamp(),
      });

      setStatus("success");
      setMessage("You are on the early access list. We will be in touch soon.");
      setFormData({
        name: "",
        email: "",
        role: "Program owner",
      });
    } catch (error) {
      console.error("Could not save early access lead:", error);
      setStatus("error");
      setMessage(
        "The page is connected, but Firestore is not accepting signups yet. Check the Firebase rules and try again.",
      );
    }
  };

  return (
    <main className="site-shell">
      <section className="hero-section" aria-labelledby="hero-title">
        <img
          className="hero-image"
          src={heroImage}
          alt="Afterschool payment dashboard on a laptop beside a mobile payment screen"
        />
        <div className="hero-shade" />
        <header className="site-header" aria-label="Primary navigation">
          <a className="brand" href="#top" aria-label="Afterschool Pay home">
            <span className="brand-mark" aria-hidden="true">
              AP
            </span>
            <span>Afterschool Pay</span>
          </a>
          <nav className="nav-links" aria-label="Page sections">
            <a href="#platform">Platform</a>
            <a href="#workflow">Workflow</a>
            <a href="#early-access">Early access</a>
          </nav>
        </header>

        <div className="hero-content" id="top">
          <p className="eyebrow">Payments and balances for enrichment teams</p>
          <h1 id="hero-title">Afterschool Pay</h1>
          <p className="hero-copy">
            A calm payment layer for after-school programs, summer camps, and
            enrichment providers that need parent payments, balances, and weekly
            reconciliation to stay in sync.
          </p>
          <div className="hero-actions" aria-label="Landing page actions">
            <a className="primary-action" href="#early-access">
              Join early access
            </a>
            <a className="secondary-action" href="#workflow">
              See the workflow
            </a>
          </div>
        </div>

        <div className="hero-proof" aria-label="Core product areas">
          <span>Parent payment links</span>
          <span>Live family balances</span>
          <span>Weekly payout records</span>
        </div>
      </section>

      <section className="section intro-section" id="platform">
        <div className="section-heading">
          <p className="eyebrow">Built for the hour after the bell</p>
          <h2>One ledger for every family, program, and school site.</h2>
        </div>
        <div className="benefit-grid">
          {benefits.map((benefit) => (
            <article className="benefit-card" key={benefit.title}>
              <h3>{benefit.title}</h3>
              <p>{benefit.text}</p>
            </article>
          ))}
        </div>
      </section>

      <section className="workflow-band" id="workflow">
        <div className="workflow-copy">
          <p className="eyebrow">From request to reconciliation</p>
          <h2>Make the payment trail clear before pickup gets crowded.</h2>
          <p>
            Afterschool Pay keeps each request tied to the right family,
            student, program, and school site from the moment money moves.
          </p>
        </div>
        <ol className="workflow-list">
          {workflows.map((step, index) => (
            <li key={step}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <p>{step}</p>
            </li>
          ))}
        </ol>
      </section>

      <section className="early-access-section" id="early-access">
        <div className="section-heading compact">
          <p className="eyebrow">Private beta</p>
          <h2>Start with the programs that still reconcile by hand.</h2>
          <p>
            Collect your first leads here while the product backend, auth, and
            payment flows come online.
          </p>
        </div>

        <form className="lead-form" onSubmit={handleSubmit}>
          <label>
            <span>Name</span>
            <input
              autoComplete="name"
              name="name"
              onChange={handleChange}
              placeholder="Your name"
              type="text"
              value={formData.name}
            />
          </label>
          <label>
            <span>Email</span>
            <input
              autoComplete="email"
              name="email"
              onChange={handleChange}
              placeholder="you@example.com"
              required
              type="email"
              value={formData.email}
            />
          </label>
          <label>
            <span>Role</span>
            <select name="role" onChange={handleChange} value={formData.role}>
              <option>Program owner</option>
              <option>School administrator</option>
              <option>Bookkeeper</option>
              <option>Parent coordinator</option>
            </select>
          </label>
          <button className="submit-button" disabled={status === "loading"}>
            {status === "loading" ? "Saving..." : "Request access"}
          </button>
          {message ? (
            <p className={`form-message ${status}`} role="status">
              {message}
            </p>
          ) : null}
        </form>
      </section>

      <footer className="site-footer">
        <p>Afterschool Pay</p>
        <a href="mailto:hello@afterschoolpay.com">hello@afterschoolpay.com</a>
      </footer>
    </main>
  );
}

export default App;
