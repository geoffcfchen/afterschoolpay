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
const DailyLedgerPage = lazy(() => import("./pages/DailyLedgerPage"));
const TeacherPayrollPage = lazy(() => import("./pages/TeacherPayrollPage"));
const TeamAccessPage = lazy(() => import("./pages/TeamAccessPage"));
const ProfileSetupPage = lazy(() => import("./pages/ProfileSetupPage"));
const OrganizationSetupPage = lazy(
  () => import("./pages/OrganizationSetupPage"),
);

const benefits = [
  {
    title: "Excel 匯入一次，之後都在系統維護",
    text: "第一次把班級、學生、科目與雜項費用匯入資料庫，後續新增班級、調整學生課程與費用都會即時儲存。",
  },
  {
    title: "繳費通知單跟著學生走",
    text: "每張通知單都存到學生帳戶底下，同一位學生跨分校上課，也能在每日收支一次看到所有未付款紀錄。",
  },
  {
    title: "每日收支同時管理收入與薪資",
    text: "櫃台可標記未付款、已逾期、已付款或作廢，也能管理老師薪資單的未發放、已發放與作廢狀態。",
  },
];

const workflows = [
  {
    title: "建立組織與分校",
    text: "負責人建立補習班工作區，再設定一校、二校、三校或新增其他分校。",
  },
  {
    title: "管理班級、科目與學生",
    text: "依國一、國二等班級查看名單，調整科目、A/B 班與點名表日期。",
  },
  {
    title: "產生繳費通知單",
    text: "從班級表格預覽學生費用，確認後把通知單存入學生帳戶。",
  },
  {
    title: "每日收支完成付款與列印",
    text: "學生到任一分校繳費時，櫃台可查到跨分校通知單並更新付款狀態。",
  },
];

const roleOptions = [
  "補習班負責人",
  "分校主管",
  "櫃台行政",
  "會計人員",
  "老師",
];

function LandingPage() {
  const [showLogin, setShowLogin] = useState(false);
  const [currentUser, setCurrentUser] = useState(null);
  const [formData, setFormData] = useState({
    name: "",
    email: "",
    role: roleOptions[0],
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
      setMessage("請留下 Email，我們才能協助你設定工作區。");
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
      setMessage("已收到資料，我們會再與你聯絡導入方式。");
      setFormData({
        name: "",
        email: "",
        role: roleOptions[0],
      });
    } catch (error) {
      console.error("Could not save early access lead:", error);
      setStatus("error");
      setMessage(
        "目前無法送出資料。請確認 Firebase rules 已發布後再試一次。",
      );
    }
  };

  return (
    <main className="site-shell">
      <section className="hero-section" aria-labelledby="hero-title">
        <img
          className="hero-image"
          src={heroImage}
          alt="補習班收費管理系統畫面"
        />
        <div className="hero-shade" />
        <header className="site-header" aria-label="主要導覽">
          <Link className="brand" to="/" aria-label="Afterschool Pay 首頁">
            <span className="brand-mark" aria-hidden="true">
              AP
            </span>
            <span>
              Afterschool Pay
              <small>補習班帳務管理</small>
            </span>
          </Link>
          <nav className="nav-links" aria-label="頁面區塊">
            <a href="#platform">功能</a>
            <a href="#workflow">流程</a>
            <a href="#early-access">開始使用</a>
          </nav>
          <div className="site-header-actions">
            {currentUser ? (
              <div className="user-chip">
                <span>
                  {currentUser.displayName || currentUser.email || "已登入"}
                </span>
                <Link to="/dashboard">控制台</Link>
                <button type="button" onClick={handleSignOut}>
                  登出
                </button>
              </div>
            ) : (
              <button
                className="nav-login-button"
                onClick={() => setShowLogin(true)}
                type="button"
              >
                登入
              </button>
            )}
          </div>
        </header>

        <div className="hero-content" id="top">
          <p className="eyebrow">給台灣補習班的收費、收據與薪資工作台</p>
          <h1 id="hero-title">補習班收費系統</h1>
          <p className="hero-copy">
            從學生課程、雜項費用、繳費通知單，到每日收支與老師薪資，
            讓一校、二校、三校可以用同一套資料管理現場帳務。
          </p>
          <div className="hero-actions" aria-label="首頁主要動作">
            {currentUser ? (
              <Link className="primary-action" to="/dashboard">
                進入控制台
              </Link>
            ) : (
              <button
                className="primary-action"
                onClick={() => setShowLogin(true)}
                type="button"
              >
                登入或建立帳號
              </button>
            )}
            <a className="secondary-action" href="#workflow">
              查看使用流程
            </a>
            <a className="secondary-action" href="#early-access">
              導入協助
            </a>
          </div>
        </div>

        <div className="hero-proof" aria-label="核心功能">
          <span>繳費通知單與收據</span>
          <span>跨分校學生帳戶</span>
          <span>老師月薪 / 8 堂課薪資</span>
        </div>
      </section>

      <section className="section intro-section" id="platform">
        <div className="section-heading">
          <p className="eyebrow">從 Excel 過渡到可長期使用的系統</p>
          <h2>把補習班每天真的會做的帳務流程整理在一起。</h2>
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
          <p className="eyebrow">工作流程</p>
          <h2>從第一次匯入資料，到每天收款與列印都能接續下去。</h2>
          <p>
            系統會先建立組織與分校，再讓每個分校管理自己的班級、學生、
            雜項費用與通知單。付款與薪資則集中到每日收支處理。
          </p>
        </div>
        <ol className="workflow-list">
          {workflows.map((step, index) => (
            <li key={step.title}>
              <span>{String(index + 1).padStart(2, "0")}</span>
              <div>
                <h3>{step.title}</h3>
                <p>{step.text}</p>
              </div>
            </li>
          ))}
        </ol>
      </section>

      <section className="early-access-section" id="early-access">
        <div className="section-heading compact">
          <p className="eyebrow">開始使用</p>
          <h2>可以先建立組織，也可以請我們協助整理第一份資料。</h2>
          <p>
            第一次通常會從既有 Excel 匯入班級與學生。匯入後資料會存進
            Firebase，之後就不需要再依賴 Excel 才能開通知單或管理收款。
          </p>
          <div className="onboarding-list" aria-label="導入重點">
            <span>建立組織後負責人成為等級 1</span>
            <span>每個分校有自己的雜項費用表</span>
            <span>每日收支負責付款、薪資與列印</span>
          </div>
        </div>

        <form className="lead-form" onSubmit={handleSubmit}>
          <label>
            <span>姓名</span>
            <input
              autoComplete="name"
              name="name"
              onChange={handleChange}
              placeholder="例如：陳主任"
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
              placeholder="name@example.com"
              required
              type="email"
              value={formData.email}
            />
          </label>
          <label>
            <span>角色</span>
            <select name="role" onChange={handleChange} value={formData.role}>
              {roleOptions.map((role) => (
                <option key={role}>{role}</option>
              ))}
            </select>
          </label>
          <button className="submit-button" disabled={status === "loading"}>
            {status === "loading" ? "送出中..." : "聯絡導入協助"}
          </button>
          {message ? (
            <p className={`form-message ${status}`} role="status">
              {message}
            </p>
          ) : null}
        </form>
      </section>

      <footer className="site-footer">
        <p>Afterschool Pay 補習班帳務管理</p>
        <a href="mailto:hello@afterschoolpay.com">聯絡我們</a>
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
        path="/daily-ledger"
        element={
          <Suspense
            fallback={
              <main className="dashboard-page">
                <div className="dashboard-loading">
                  <span className="brand-mark dark" aria-hidden="true">
                    AP
                  </span>
                  <p>正在載入每日收支...</p>
                </div>
              </main>
            }
          >
            <DailyLedgerPage />
          </Suspense>
        }
      />
      <Route
        path="/teacher-payroll"
        element={
          <Suspense
            fallback={
              <main className="dashboard-page">
                <div className="dashboard-loading">
                  <span className="brand-mark dark" aria-hidden="true">
                    AP
                  </span>
                  <p>正在載入老師薪資...</p>
                </div>
              </main>
            }
          >
            <TeacherPayrollPage />
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
        path="/profile-setup"
        element={
          <Suspense
            fallback={
              <main className="auth-page">
                <div className="dashboard-loading">
                  <span className="brand-mark dark" aria-hidden="true">
                    AP
                  </span>
                  <p>正在載入帳號資料...</p>
                </div>
              </main>
            }
          >
            <ProfileSetupPage />
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
