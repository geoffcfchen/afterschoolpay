import { Suspense, lazy, useEffect, useState } from "react";
import { onAuthStateChanged, signOut } from "firebase/auth";
import { addDoc, collection, serverTimestamp } from "firebase/firestore/lite";
import { Link, Route, Routes } from "react-router-dom";
import heroImage from "./assets/afterschoolpay-hero.png";
import LoginModal from "./components/LoginModal";
import DashboardPage from "./pages/DashboardPage";
import EmailRegisterPage from "./pages/EmailRegisterPage";
import LoginPage from "./pages/LoginPage";
import { auth, firestore } from "./lib/firebase";
import "./App.css";

const StudentsCoursesPage = lazy(() => import("./pages/StudentsCoursesPage"));
const TeamAccessPage = lazy(() => import("./pages/TeamAccessPage"));
const OrganizationSetupPage = lazy(
  () => import("./pages/OrganizationSetupPage"),
);

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

function LandingPage() {
  const [showLogin, setShowLogin] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    role: "Program owner",
  });
  const [status, setStatus] = useState("idle");
  const [message, setMessage] = useState("");

  useEffect(() => {
    if (!auth) {
      return undefined;
    }

    const unsubscribe = onAuthStateChanged(auth, (user) => {
      setCurrentUser(user);
    });

    return unsubscribe;
  }, []);

  const handleSignOut = async () => {
    if (!auth) {
      return;
    }

    await signOut(auth);
  };

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
          <Link className="brand" to="/" aria-label="Afterschool Pay home">
            <span className="brand-mark" aria-hidden="true">
              AP
            </span>
            <span>Afterschool Pay</span>
          </Link>
          <nav className="nav-links" aria-label="Page sections">
            <a href="#platform">Platform</a>
            <a href="#workflow">Workflow</a>
            <a href="#early-access">Early access</a>
          </nav>
          <div className="site-header-actions">
            {currentUser ? (
              <div className="user-chip">
                <span>{currentUser.email || "Signed in"}</span>
                <Link to="/dashboard">Dashboard</Link>
                <button type="button" onClick={handleSignOut}>
                  Log out
                </button>
              </div>
            ) : (
              <button
                className="nav-login-button"
                onClick={() => setShowLogin(true)}
                type="button"
              >
                Log in
              </button>
            )}
          </div>
        </header>

        <div className="hero-content" id="top">
          <p className="eyebrow">Payments and balances for enrichment teams</p>
          <h1 id="hero-title">Afterschool Pay</h1>
          <p className="hero-copy">
            Afterschool programs, summer camps, and enrichment providers that
            need parent payments, balances, and weekly reconciliation to stay in
            sync.
          </p>
          <div className="hero-actions" aria-label="Landing page actions">
            <a className="primary-action" href="#early-access">
              Join early access
            </a>
            <a className="secondary-action" href="#workflow">
              See the workflow
            </a>
            {!currentUser ? (
              <button
                className="secondary-action"
                onClick={() => setShowLogin(true)}
                type="button"
              >
                Log in or sign up
              </button>
            ) : (
              <Link className="secondary-action" to="/dashboard">
                Open dashboard
              </Link>
            )}
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
      <LoginModal open={showLogin} onClose={() => setShowLogin(false)} />
    </main>
  );
}

function App() {
  return (
    <Routes>
      <Route path="/" element={<LandingPage />} />
      <Route path="/dashboard" element={<DashboardPage />} />
      <Route
        path="/students-courses"
        element={
          <Suspense
            fallback={
              <main className="dashboard-page">
                <div className="dashboard-loading">
                  <span className="brand-mark dark" aria-hidden="true">
                    AP
                  </span>
                  <p>正在載入學生與課程...</p>
                </div>
              </main>
            }
          >
            <StudentsCoursesPage />
          </Suspense>
        }
      />
      <Route
        path="/team-access"
        element={
          <Suspense
            fallback={
              <main className="dashboard-page">
                <div className="dashboard-loading">
                  <span className="brand-mark dark" aria-hidden="true">
                    AP
                  </span>
                  <p>正在載入團隊權限...</p>
                </div>
              </main>
            }
          >
            <TeamAccessPage />
          </Suspense>
        }
      />
      <Route
        path="/organization-setup"
        element={
          <Suspense
            fallback={
              <main className="auth-page">
                <div className="dashboard-loading">
                  <span className="brand-mark dark" aria-hidden="true">
                    AP
                  </span>
                  <p>正在載入組織設定...</p>
                </div>
              </main>
            }
          >
            <OrganizationSetupPage />
          </Suspense>
        }
      />
      <Route path="/login" element={<LoginPage />} />
      <Route path="/register-email" element={<EmailRegisterPage />} />
      <Route path="*" element={<LandingPage />} />
    </Routes>
  );
}

export default App;
