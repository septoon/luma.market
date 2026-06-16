import {
  ArrowLeft,
  Bell,
  CalendarDays,
  Check,
  ChevronRight,
  Clock3,
  CreditCard,
  FileText,
  LockKeyhole,
  LogOut,
  Receipt,
  RefreshCw,
  RotateCcw,
  Share,
  Store,
  UserRound,
  WalletCards,
} from "lucide-react";
import { FormEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useRef, useState, type UIEvent } from "react";
import { api, clearSessionToken, getSavedUserName, hasSessionToken, isUnauthorizedError, setSessionToken, type ReportQuery } from "./api";
import type { Analytics, AuthOrganization, DashboardSummary, Operation, PaymentKind, ReportPeriod } from "./types";

type View = "welcome" | "login" | "home" | "operation" | "analytics" | "journal" | "returns";
type JournalPeriod = "today" | "yesterday" | "week" | "all";
type SalesChartMode = "hours" | "days" | "weeks";
type SoldItem = { name: string; quantity: number; unit: string; amount: number };
type SalesChartPoint = { label: string; value: number };

const money = new Intl.NumberFormat("ru-RU", {
  style: "currency",
  currency: "RUB",
  maximumFractionDigits: 0,
});

const paymentColors: Record<PaymentKind, string> = {
  cash: "#22b449",
  card: "#55c96d",
  sbp: "#b7eabf",
  paid: "#22b449",
  notPaid: "#f4c84f",
  refund: "#ef4444",
  cancel: "#f97316",
  unknown: "#c7d1ca",
};

const journalPeriodLabels: Record<JournalPeriod, string> = {
  today: "Сегодня",
  yesterday: "Вчера",
  week: "Неделя",
  all: "Все",
};

const reportPeriodLabels: Record<Exclude<ReportPeriod, "date">, string> = {
  today: "Сегодня",
  yesterday: "Вчера",
  week: "Неделя",
  month: "Месяц",
};

const defaultUserName = "Пользователь";

type NotificationState = "loading" | "unsupported" | "unconfigured" | "ready" | "enabled" | "denied" | "error";

function todayDateInputValue() {
  const now = new Date();
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, "0");
  const day = String(now.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function startOfDay(date: Date) {
  const result = new Date(date);
  result.setHours(0, 0, 0, 0);
  return result;
}

function addDays(date: Date, days: number) {
  const result = new Date(date);
  result.setDate(result.getDate() + days);
  return result;
}

function addMonths(date: Date, months: number) {
  const result = new Date(date);
  result.setMonth(result.getMonth() + months);
  return result;
}

function parseDateOnly(value: string | undefined) {
  if (!value) return null;
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return null;
  const date = new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]));
  return Number.isNaN(date.getTime()) ? null : date;
}

function reportPeriodRange(query: ReportQuery) {
  const today = startOfDay(new Date());
  const tomorrow = addDays(today, 1);
  if (query.period === "yesterday") return { start: addDays(today, -1), end: today };
  if (query.period === "week") return { start: addDays(today, -6), end: tomorrow };
  if (query.period === "month") return { start: addMonths(today, -1), end: tomorrow };
  if (query.period === "date") {
    const selected = parseDateOnly(query.date) ?? today;
    return { start: selected, end: addDays(selected, 1) };
  }
  return { start: today, end: tomorrow };
}

function daysInReportRange(query: ReportQuery) {
  const range = reportPeriodRange(query);
  return Math.max(1, Math.round((range.end.getTime() - range.start.getTime()) / 86_400_000));
}

function operationDeepLinkId() {
  return new URLSearchParams(window.location.search).get("operation");
}

function isValidReceiptUrl(value: string | undefined) {
  if (!value) return false;
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch {
    return false;
  }
}

function clearOperationDeepLink() {
  const url = new URL(window.location.href);
  if (!url.searchParams.has("operation")) return;
  url.searchParams.delete("operation");
  window.history.replaceState({}, "", `${url.pathname}${url.search}${url.hash}`);
}

function reportTitle(query: ReportQuery) {
  if (query.period === "today") return "Выручка за сегодня";
  if (query.period === "yesterday") return "Выручка за вчера";
  if (query.period === "week") return "Выручка за неделю";
  if (query.period === "month") return "Выручка за месяц";
  return `Выручка за ${query.date?.split("-").reverse().join(".") ?? "день"}`;
}

function comparisonLabel(query: ReportQuery) {
  if (query.period === "today" || query.period === "date") return "к предыдущему дню";
  if (query.period === "yesterday") return "к позавчера";
  if (query.period === "week") return "к предыдущей неделе";
  return "к предыдущему месяцу";
}

function urlBase64ToUint8Array(value: string) {
  const padding = "=".repeat((4 - (value.length % 4)) % 4);
  const base64 = `${value}${padding}`.replace(/-/g, "+").replace(/_/g, "/");
  const rawData = window.atob(base64);
  const output = new Uint8Array(rawData.length);

  for (let index = 0; index < rawData.length; index += 1) {
    output[index] = rawData.charCodeAt(index);
  }

  return output;
}

function supportsPushNotifications() {
  return "serviceWorker" in navigator && "PushManager" in window && "Notification" in window;
}

async function getServiceWorkerRegistration() {
  const existing = await navigator.serviceWorker.getRegistration("/");
  if (existing) {
    existing.update().catch(() => undefined);
    return existing;
  }
  return navigator.serviceWorker.register("/sw.js");
}

function pushRecoveryMessage(state: NotificationState) {
  if (state === "unsupported") return "Откройте установленное приложение с экрана Домой";
  if (state === "denied") return "Разрешите уведомления в iOS или переустановите PWA";
  if (state === "error") return "Повторить включение";
  return null;
}

function NotificationButton() {
  const [state, setState] = useState<NotificationState>("loading");
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    let isMounted = true;

    async function loadState() {
      if (!supportsPushNotifications()) {
        setState("unsupported");
        return;
      }

      try {
        const pushInfo = await api.pushPublicKey();
        if (!pushInfo.configured || !pushInfo.publicKey) {
          if (!isMounted) return;
          setState("unconfigured");
          return;
        }

        if (Notification.permission === "denied") {
          if (!isMounted) return;
          setState("denied");
          setMessage(pushRecoveryMessage("denied"));
          return;
        }

        const registration = await getServiceWorkerRegistration();
        const subscription = await registration.pushManager.getSubscription();
        if (!isMounted) return;

        if (subscription) {
          await api.savePushSubscription(subscription.toJSON());
          setState("enabled");
          return;
        }

        setState("ready");
      } catch {
        if (isMounted) {
          setState("error");
          setMessage(pushRecoveryMessage("error"));
        }
      }
    }

    loadState();
    return () => {
      isMounted = false;
    };
  }, []);

  async function enableNotifications() {
    if (!supportsPushNotifications()) {
      setState("unsupported");
      setMessage(pushRecoveryMessage("unsupported"));
      return;
    }
    setState("loading");
    setMessage(null);

    try {
      const pushInfo = await api.pushPublicKey();
      if (!pushInfo.publicKey) {
        setState("unconfigured");
        return;
      }

      const permission = await Notification.requestPermission();
      if (permission !== "granted") {
        setState(permission === "denied" ? "denied" : "ready");
        setMessage(permission === "denied" ? pushRecoveryMessage("denied") : "Разрешение не выдано");
        return;
      }

      const registration = await getServiceWorkerRegistration();
      const existing = await registration.pushManager.getSubscription();
      const subscription =
        existing ??
        (await registration.pushManager.subscribe({
          userVisibleOnly: true,
          applicationServerKey: urlBase64ToUint8Array(pushInfo.publicKey),
        }));

      await api.savePushSubscription(subscription.toJSON());
      setState("enabled");
      setMessage("Включены");
    } catch {
      setState("error");
      setMessage("Не удалось включить");
    }
  }

  async function disableNotifications() {
    if (!supportsPushNotifications()) return;
    setState("loading");
    setMessage(null);

    try {
      const registration = await getServiceWorkerRegistration();
      const subscription = await registration.pushManager.getSubscription();
      if (subscription) {
        await api.deletePushSubscription(subscription.endpoint);
        await subscription.unsubscribe();
      }
      setState("ready");
    } catch {
      setState("error");
      setMessage("Не удалось выключить");
    }
  }

  const disabled = state === "loading" || state === "unconfigured";
  const label =
    state === "enabled"
      ? "Уведомления включены"
      : state === "unconfigured"
        ? "Web Push не настроен"
        : state === "unsupported"
          ? "Уведомления не поддерживаются"
          : state === "denied"
            ? "Уведомления запрещены"
            : "Включить уведомления";

  return (
    <button
      className={`notificationButton ${state}`}
      onClick={state === "enabled" ? disableNotifications : enableNotifications}
      disabled={disabled}
      aria-label={label}
      title={message ?? pushRecoveryMessage(state) ?? label}
    >
      {state === "enabled" ? <Check size={17} /> : <Bell size={17} />}
      <span>{state === "enabled" ? "Push" : "Push"}</span>
    </button>
  );
}

function ReportPeriodControl({
  query,
  onChange,
}: {
  query: ReportQuery;
  onChange: (query: ReportQuery) => void;
}) {
  return (
    <section className="reportControl panel">
      <div className="segmented reportSegment">
        {(Object.keys(reportPeriodLabels) as Array<Exclude<ReportPeriod, "date">>).map((period) => (
          <button key={period} className={query.period === period ? "active" : ""} onClick={() => onChange({ period })}>
            {reportPeriodLabels[period]}
          </button>
        ))}
      </div>
      <label className={query.period === "date" ? "calendarPick active" : "calendarPick"}>
        <CalendarDays size={19} />
        {query.period === "date" && query.date ? query.date.split("-").reverse().join(".") : "Дата"}
        <input
          className="nativeDateInput"
          type="date"
          value={query.date ?? todayDateInputValue()}
          onChange={(event) => onChange({ period: "date", date: event.target.value })}
          aria-label="Выбрать дату отчета"
        />
      </label>
    </section>
  );
}

function formatMoney(value: number) {
  return money.format(value).replace("RUB", "₽");
}

function Delta({ value, tone = "good" }: { value: number | null; tone?: "good" | "bad" }) {
  if (value === null) return null;

  return (
    <span className={tone === "bad" ? "delta deltaBad" : "delta"}>
      {value >= 0 ? "↑" : "↓"} {Math.abs(value).toLocaleString("ru-RU")}%
    </span>
  );
}

function AppHeader({
  title,
  onBack,
  right,
}: {
  title: string;
  onBack?: () => void;
  right?: ReactNode;
}) {
  return (
    <header className={onBack ? "appHeader" : "appHeader noBack"}>
      <button className={onBack ? "iconButton" : "iconButton placeholderButton"} onClick={onBack} aria-label="Назад">
        <ArrowLeft size={22} />
      </button>
      <strong>{title}</strong>
      <div className="headerRight">{right}</div>
    </header>
  );
}

function MetricCard({
  label,
  value,
  delta,
  bad,
}: {
  label: string;
  value: string;
  delta: number | null;
  bad?: boolean;
}) {
  return (
    <article className="metricCard">
      <span>{label}</span>
      <strong>{value}</strong>
      <Delta value={delta} tone={bad ? "bad" : "good"} />
    </article>
  );
}

function WelcomeScreen({ onStart }: { onStart: () => void }) {
  return (
    <main className="screen welcomeScreen">
      <section className="welcomeCopy">
        <h1>Люма.Маркет</h1>
        <p>Удаленный мониторинг продаж на кассах LIFE POS в реальном времени</p>
      </section>
      <img className="welcomeImage" src="/login_image.png" alt="" aria-hidden="true" />

      <button className="primaryButton" onClick={onStart}>
        Войти
      </button>
    </main>
  );
}

const maxPhoneDigits = 15;

function normalizePhone(value: string) {
  const digits = value.replace(/\D/g, "").slice(0, maxPhoneDigits);
  if (!digits) return "";
  if (digits.startsWith("8") && digits.length > 1) return `7${digits.slice(1)}`.slice(0, maxPhoneDigits);
  if (digits.startsWith("9") && digits.length <= 10) return `7${digits}`.slice(0, 11);
  return digits;
}

function formatPhoneForInput(value: string) {
  const digits = normalizePhone(value);
  if (!digits) return "";

  if (!digits.startsWith("7")) return `+${digits}`;

  const local = digits.slice(1, 11);
  const parts = ["+7"];
  if (local.length > 0) parts.push(local.slice(0, 3));
  if (local.length > 3) parts.push(local.slice(3, 6));
  if (local.length > 6) parts.push(local.slice(6, 8));
  if (local.length > 8) parts.push(local.slice(8, 10));

  return parts.join(" ");
}

function LoginScreen({ onLogin }: { onLogin: (sessionToken: string, userName?: string) => Promise<void> }) {
  const [phone, setPhone] = useState("");
  const [password, setPassword] = useState("");
  const [authId, setAuthId] = useState("");
  const [organizations, setOrganizations] = useState<AuthOrganization[]>([]);
  const [selectedOrgGuid, setSelectedOrgGuid] = useState("");
  const [isBusy, setBusy] = useState(false);
  const [error, setError] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError("");
    try {
      if (authId) {
        const result = await api.selectOrg(authId, selectedOrgGuid);
        await onLogin(result.sessionToken, result.userName);
        return;
      }

      const normalizedPhone = normalizePhone(phone);
      if (normalizedPhone.length < 7) {
        setError("Укажи номер телефона с кодом страны.");
        return;
      }

      const result = await api.login(normalizedPhone, password);
      if (result.sessionToken) {
        await onLogin(result.sessionToken, result.userName);
        return;
      }

      setOrganizations(result.organizations);
      setAuthId(result.authId ?? "");
      setSelectedOrgGuid(result.organizations[0]?.guid ?? "");
    } catch {
      setError("Не удалось войти. Проверь номер, пароль или доступ к LIFE POS.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="screen loginScreen">
      <section className="loginCard">
        <div className="loginIcon">
          <LockKeyhole size={26} />
        </div>
        <h1>Доступ владельца</h1>
        <p>Введите данные LIFE PAY.</p>
        <form onSubmit={submit}>
          {!authId ? (
            <>
              <label>
                Номер телефона
                <input
                  type="tel"
                  inputMode="tel"
                  placeholder="+7 999 000 00 00"
                  autoComplete="username"
                  value={formatPhoneForInput(phone)}
                  onChange={(event) => setPhone(normalizePhone(event.target.value))}
                  required
                />
              </label>
              <label>
                Пароль LIFE POS
                <input
                  type="password"
                  placeholder="Пароль от lk.life-pay.ru"
                  autoComplete="current-password"
                  value={password}
                  onChange={(event) => setPassword(event.target.value)}
                  required
                />
              </label>
            </>
          ) : (
            <label>
              Организация
              <select value={selectedOrgGuid} onChange={(event) => setSelectedOrgGuid(event.target.value)} required>
                {organizations.map((org) => (
                  <option key={org.guid} value={org.guid}>
                    {org.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          {error ? <span className="formError">{error}</span> : null}
          <button className="primaryButton" disabled={isBusy}>
            {isBusy ? "Проверяем..." : authId ? "Войти в организацию" : "Продолжить"}
          </button>
        </form>
      </section>
    </main>
  );
}

function PaymentBreakdown({ summary }: { summary: DashboardSummary }) {
  return (
    <section className="panel">
      <h2>Разбивка по способам оплаты</h2>
      {summary.payments.length > 0 ? (
        <div className="paymentGrid">
          {summary.payments.map((payment) => (
            <div className="paymentMetric" key={payment.kind}>
              <span>{payment.label}</span>
              <strong>{formatMoney(payment.amount)}</strong>
              <small>{payment.percent}%</small>
              <div className="progressTrack">
                <span style={{ width: `${payment.percent}%`, background: paymentColors[payment.kind] }} />
              </div>
            </div>
          ))}
        </div>
      ) : (
        <p className="emptyText">За выбранный период оплат не найдено</p>
      )}
    </section>
  );
}

function TopSoldItemsPreview({ analytics, onOpen }: { analytics: Analytics; onOpen: () => void }) {
  const items = analytics.soldItemsByPeriod.today.slice(0, 5);

  return (
    <section className="panel soldProductsPanel compactProducts">
      <div className="sectionHead">
        <h2>Продано за период</h2>
        <button onClick={onOpen}>
          Подробнее <ChevronRight size={16} />
        </button>
      </div>
      <div className="soldProductsList">
        {items.length > 0 ? (
          items.map((item, index) => (
            <div className="soldProductRow" key={item.name}>
              <span className="soldProductRank">{index + 1}</span>
              <span className="soldProductName">{item.name}</span>
              <strong>
                {item.quantity.toLocaleString("ru-RU")} {item.unit === "Штука" ? "шт." : item.unit}
              </strong>
              <small>{formatMoney(item.amount)}</small>
            </div>
          ))
        ) : (
          <p className="emptyText">Проданные товары и услуги за период не найдены</p>
        )}
      </div>
    </section>
  );
}

function OperationRow({ operation, onOpen }: { operation: Operation; onOpen: () => void }) {
  const isShiftEvent = operation.kind === "shiftOpen" || operation.kind === "shiftClose";
  const isRefund = operation.kind === "refund" || operation.kind === "cancel";
  const title =
    operation.kind === "shiftOpen"
      ? "Открытие смены"
      : operation.kind === "shiftClose"
        ? "Закрытие смены"
        : operation.kind === "refund"
          ? "Возврат"
          : operation.kind === "cancel"
            ? "Отмена"
            : operation.kind === "unknown"
              ? "Операция"
              : "Продажа";

  return (
    <button className={isShiftEvent ? "operationRow shiftEvent" : "operationRow"} onClick={onOpen}>
      <span className={isRefund ? "rowIcon refund" : isShiftEvent ? "rowIcon shift" : "rowIcon"}>
        {isRefund ? <RotateCcw size={18} /> : isShiftEvent ? <Clock3 size={18} /> : <Receipt size={18} />}
      </span>
      <span className="rowMain">
        <strong>{title}</strong>
        <small>{isShiftEvent ? operation.dateTime : `№ ${operation.number}`}</small>
        {isShiftEvent && operation.cashier ? <small>{operation.cashier}</small> : null}
      </span>
      <span className="rowTime">{operation.time}</span>
      {isShiftEvent ? <strong className="amount shiftAmount">{operation.cashbox}</strong> : null}
      {!isShiftEvent ? (
        <strong className={isRefund ? "amount refundText" : "amount"}>
          {isRefund ? "− " : ""}
          {formatMoney(Math.abs(operation.amount))}
        </strong>
      ) : null}
      <ChevronRight size={18} className="mutedIcon" />
    </button>
  );
}

function shiftStatusLabel(status: DashboardSummary["shiftStatus"]) {
  if (status === "open") return "Открыта";
  if (status === "closed") return "Закрыта";
  return "Неизвестно";
}

function shiftOpenedLine(summary: DashboardSummary) {
  const openedAt = summary.shiftOpenedAt === "Нет данных" || summary.shiftOpenedAt === "--:--" ? "—" : summary.shiftOpenedAt;
  return `Открыта: ${openedAt}`;
}

function shouldShowShiftPanel(query: ReportQuery) {
  return query.period === "today" || query.period === "yesterday" || query.period === "date";
}

function HomeScreen({
  summary,
  analytics,
  operations,
  userName,
  query,
  onQueryChange,
  onOpenOperation,
  onAnalytics,
  onJournal,
  onLogout,
  onRefresh,
}: {
  summary: DashboardSummary;
  analytics: Analytics;
  operations: Operation[];
  userName: string;
  query: ReportQuery;
  onQueryChange: (query: ReportQuery) => void;
  onOpenOperation: (id: string) => void;
  onAnalytics: () => void;
  onJournal: () => void;
  onLogout: () => void;
  onRefresh: () => void;
}) {
  const lastScrollTopRef = useRef(0);
  const isBottomNavHiddenRef = useRef(false);
  const [isBottomNavHidden, setBottomNavHidden] = useState(false);

  function handleHomeScroll(event: UIEvent<HTMLElement>) {
    const nextScrollTop = event.currentTarget.scrollTop;
    const previousScrollTop = lastScrollTopRef.current;
    const delta = nextScrollTop - previousScrollTop;

    if (Math.abs(delta) > 8) {
      const shouldHide = delta > 0 && nextScrollTop > 120;
      if (shouldHide !== isBottomNavHiddenRef.current) {
        isBottomNavHiddenRef.current = shouldHide;
        setBottomNavHidden(shouldHide);
      }
      lastScrollTopRef.current = nextScrollTop;
    }
  }

  return (
    <main className="screen homeScreen" onScroll={handleHomeScroll}>
      <AppHeader
        title={userName}
        right={
          <>
            <NotificationButton />
            <button className="iconButton" onClick={onLogout} aria-label="Выйти">
              <LogOut size={19} />
            </button>
          </>
        }
      />
      <ReportPeriodControl query={query} onChange={onQueryChange} />
      <section className="heroRevenue">
        <div className="revenueLine">
          <div className="revenueMain">
            <span>{reportTitle(query)}</span>
            <h1>{formatMoney(summary.revenue)}</h1>
          </div>
          {summary.revenueDelta !== null ? (
            <div className="deltaPill" aria-label={comparisonLabel(query)}>
              <Delta value={summary.revenueDelta} />
              <small>{comparisonLabel(query)}</small>
            </div>
          ) : null}
        </div>
      </section>
      <section className="metricsGrid three">
        <MetricCard label="Количество продаж" value={String(summary.salesCount)} delta={summary.salesDelta} />
        <MetricCard label="Средний чек" value={formatMoney(summary.avgCheck)} delta={summary.avgCheckDelta} />
        <MetricCard label="Средний чек (возвраты)" value={`− ${formatMoney(summary.avgRefund)}`} delta={summary.avgRefundDelta} bad />
      </section>
      {shouldShowShiftPanel(query) ? (
        <section className="panel shiftPanel">
          <div>
            <h2>Смена</h2>
            <p>{shiftOpenedLine(summary)}</p>
            <p>Закрыта: {summary.shiftClosedAt ?? "—"}</p>
            {summary.cashbox ? <p>Касса: {summary.cashbox}</p> : null}
          </div>
          <div className="shiftStatus">
            <span className={summary.shiftStatus}>{shiftStatusLabel(summary.shiftStatus)}</span>
          </div>
        </section>
      ) : null}
      <PaymentBreakdown summary={summary} />
      <TopSoldItemsPreview analytics={analytics} onOpen={onAnalytics} />
      <section className="panel">
        <div className="sectionHead">
          <h2>Последние операции</h2>
          <button onClick={onJournal}>
            Все <ChevronRight size={16} />
          </button>
        </div>
        <div className="operationList">
          {operations.length > 0 ? (
            operations.slice(0, 4).map((operation) => (
              <OperationRow key={operation.id} operation={operation} onOpen={() => onOpenOperation(operation.id)} />
            ))
          ) : (
            <p className="emptyText">За выбранный период операций не найдено</p>
          )}
        </div>
      </section>
      <nav className={`bottomActions ${isBottomNavHidden ? "isHidden" : ""}`} aria-label="Основные действия">
        <button onClick={onRefresh}>
          <RefreshCw size={25} />
          <span>Обновить</span>
        </button>
        <button onClick={onJournal}>
          <FileText size={23} />
          <span>Журнал</span>
        </button>
        <button onClick={onAnalytics}>
          <CalendarDays size={24} />
          <span>Аналитика</span>
        </button>
      </nav>
    </main>
  );
}

function getOperationDate(operation: Operation) {
  const date = new Date(operation.openedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isOperationInPeriod(operation: Operation, period: JournalPeriod) {
  if (period === "all") return true;
  const date = getOperationDate(operation);
  if (!date) return false;
  const now = new Date();
  const today = new Date(now);
  today.setHours(0, 0, 0, 0);
  const tomorrow = new Date(today);
  tomorrow.setDate(tomorrow.getDate() + 1);
  const yesterday = new Date(today);
  yesterday.setDate(yesterday.getDate() - 1);
  const week = new Date(today);
  week.setDate(week.getDate() - 6);

  if (period === "today") return date >= today && date < tomorrow;
  if (period === "yesterday") return date >= yesterday && date < today;
  return date >= week && date < tomorrow;
}

function JournalScreen({
  operations,
  onBack,
  onOpenOperation,
}: {
  operations: Operation[];
  onBack: () => void;
  onOpenOperation: (id: string) => void;
}) {
  const [period, setPeriod] = useState<JournalPeriod>("today");
  const visibleOperations = operations.filter((operation) => isOperationInPeriod(operation, period));
  const total = visibleOperations.reduce((sum, operation) => {
    if (operation.kind === "sale") return sum + operation.amount;
    if (operation.kind === "refund" || operation.kind === "cancel") return sum - operation.amount;
    return sum;
  }, 0);

  return (
    <main className="screen journalScreen">
      <AppHeader title="Журнал операций" onBack={onBack} />
      <section className="panel journalSummary">
        <span>Операции за период</span>
        <strong>{visibleOperations.length}</strong>
        <small>{formatMoney(total)}</small>
      </section>
      <section className="panel">
        <div className="segmented journalSegment">
          {(Object.keys(journalPeriodLabels) as JournalPeriod[]).map((item) => (
            <button key={item} className={period === item ? "active" : ""} onClick={() => setPeriod(item)}>
              {journalPeriodLabels[item]}
            </button>
          ))}
        </div>
      </section>
      <section className="panel">
        <div className="sectionHead">
          <h2>Продажи и оплаты</h2>
        </div>
        <div className="operationList">
          {visibleOperations.length > 0 ? (
            visibleOperations.map((operation) => (
              <OperationRow key={operation.id} operation={operation} onOpen={() => onOpenOperation(operation.id)} />
            ))
          ) : (
            <p className="emptyText">За выбранный период операций не найдено</p>
          )}
        </div>
      </section>
    </main>
  );
}

function OperationScreen({ operation, onBack }: { operation: Operation; onBack: () => void }) {
  const isShiftEvent = operation.kind === "shiftOpen" || operation.kind === "shiftClose";
  const shiftTitle = operation.kind === "shiftOpen" ? "Открытие смены" : operation.kind === "shiftClose" ? "Закрытие смены" : "";
  const statusLabel = isShiftEvent
    ? "Документ сформирован"
    : operation.receiptStatus === "sent"
      ? "Чек отправлен"
      : operation.receiptStatus === "failed"
        ? "Ошибка чека"
        : "Чек ожидает данных";
  const signedAmount = operation.kind === "refund" || operation.kind === "cancel" ? `− ${formatMoney(operation.amount)}` : formatMoney(operation.amount);
  const receiptUrl = isValidReceiptUrl(operation.fiscalReceiptUrl) ? operation.fiscalReceiptUrl : undefined;

  return (
    <main className="screen">
      <AppHeader
        title="Операция"
        onBack={onBack}
        right={
          <button className="iconButton" aria-label="Поделиться">
            <Share size={21} />
          </button>
        }
      />
      <section className={isShiftEvent ? "operationAmount shiftDocumentAmount panel" : "operationAmount panel"}>
        <span>{isShiftEvent ? "Фискальный документ" : "Сумма операции"}</span>
        <div>
          <h1>{isShiftEvent ? shiftTitle : signedAmount}</h1>
          <strong className={operation.receiptStatus === "failed" ? "statusBadge statusBad" : "statusBadge"}>
            {statusLabel} <Check size={16} />
          </strong>
        </div>
      </section>
      <section className="panel infoList">
        {isShiftEvent ? <InfoLine icon={<FileText size={18} />} label="Тип документа" value={shiftTitle} /> : null}
        {!isShiftEvent ? <InfoLine icon={<CreditCard size={18} />} label="Способ оплаты" value={operation.paymentLabel} /> : null}
        <InfoLine icon={<Store size={18} />} label="Касса" value={operation.cashbox} />
        <InfoLine icon={<UserRound size={18} />} label="Кассир" value={operation.cashier} />
        <InfoLine icon={<Clock3 size={18} />} label="Дата и время" value={operation.dateTime} />
        <InfoLine icon={<WalletCards size={18} />} label="Номер операции" value={`№ ${operation.number}`} />
        <InfoLine icon={<Receipt size={18} />} label={isShiftEvent ? "Номер фискального документа" : "Номер чека"} value={`№ ${operation.receiptNumber}`} />
      </section>
      {!isShiftEvent ? (
        <section className="panel receiptPanel">
          <h2>Состав покупки</h2>
          {operation.items.map((item) => (
            <div className="receiptLine" key={item.name}>
              <span>{item.name}</span>
              <small>{item.qty} шт</small>
              <small>{formatMoney(item.unitPrice)}</small>
              <strong>{formatMoney(item.total)}</strong>
            </div>
          ))}
          <div className="receiptTotals">
            <span>Подытог</span>
            <strong>{formatMoney(operation.subtotal)}</strong>
            <span>Скидка</span>
            <strong className="refundText">− {formatMoney(operation.discount)}</strong>
            <span>Итого</span>
            <strong>{formatMoney(operation.amount)}</strong>
          </div>
        </section>
      ) : null}
      {receiptUrl ? (
        <button className="primaryButton receiptViewButton" onClick={() => window.open(receiptUrl, "_blank", "noopener,noreferrer")}>
          🧾 Просмотреть чек
        </button>
      ) : null}
      <p className="readonlyNotice">Приложение не изменяет продажи, возвраты, смены или кассу.</p>
    </main>
  );
}

function InfoLine({ icon, label, value }: { icon: React.ReactNode; label: string; value: string }) {
  return (
    <div className="infoLine">
      <span className="infoIcon">{icon}</span>
      <span>{label}</span>
      <strong>{value}</strong>
    </div>
  );
}

const chartModeLabels: Record<SalesChartMode, string> = {
  hours: "Часы",
  days: "Дни",
  weeks: "Недели",
};

function operationDate(operation: Operation) {
  const date = new Date(operation.openedAt);
  return Number.isNaN(date.getTime()) ? null : date;
}

function isSaleForAnalytics(operation: Operation) {
  return operation.kind === "sale" && operation.amount > 0;
}

function isOperationWithinQuery(operation: Operation, query: ReportQuery) {
  const date = operationDate(operation);
  const range = reportPeriodRange(query);
  return Boolean(date && date >= range.start && date < range.end);
}

function availableSalesChartModes(query: ReportQuery): SalesChartMode[] {
  if (query.period === "month") return ["hours", "days", "weeks"];
  if (query.period === "week") return ["hours", "days"];

  const days = daysInReportRange(query);
  if (days === 1) return ["hours"];
  if (days <= 14) return ["hours", "days"];
  return ["days", "weeks"];
}

function formatDayLabel(date: Date, showWeekday: boolean) {
  if (showWeekday) return date.toLocaleDateString("ru-RU", { weekday: "short" }).replace(".", "");
  return date.toLocaleDateString("ru-RU", { day: "2-digit", month: "2-digit" });
}

function aggregateSoldItems(operations: Operation[], query: ReportQuery): SoldItem[] {
  const items = new Map<string, SoldItem>();

  for (const operation of operations) {
    if (!isSaleForAnalytics(operation) || !isOperationWithinQuery(operation, query)) continue;

    for (const item of operation.items) {
      const existing = items.get(item.name) ?? { name: item.name, quantity: 0, unit: "шт", amount: 0 };
      existing.quantity += item.qty;
      existing.amount += item.total;
      items.set(item.name, existing);
    }
  }

  return [...items.values()].sort((a, b) => b.quantity - a.quantity).slice(0, 10);
}

function aggregateSalesChart(operations: Operation[], query: ReportQuery, mode: SalesChartMode): SalesChartPoint[] {
  const range = reportPeriodRange(query);
  const sales = operations.filter((operation) => isSaleForAnalytics(operation) && isOperationWithinQuery(operation, query));

  if (mode === "hours") {
    const points = Array.from({ length: 24 }, (_, hour) => ({
      label: `${String(hour).padStart(2, "0")}:00`,
      value: 0,
    }));

    for (const operation of sales) {
      const date = operationDate(operation);
      if (date) points[date.getHours()].value += operation.amount;
    }

    return points;
  }

  if (mode === "weeks") {
    const days = daysInReportRange(query);
    const weekCount = Math.max(1, Math.ceil(days / 7));
    const points = Array.from({ length: weekCount }, (_, index) => ({
      label: `${index + 1} нед.`,
      value: 0,
    }));

    for (const operation of sales) {
      const date = operationDate(operation);
      if (!date) continue;
      const index = Math.min(points.length - 1, Math.floor((date.getTime() - range.start.getTime()) / 604_800_000));
      points[index].value += operation.amount;
    }

    return points;
  }

  const days = daysInReportRange(query);
  const showWeekday = days <= 7;
  const points = Array.from({ length: days }, (_, index) => {
    const date = addDays(range.start, index);
    return { label: formatDayLabel(date, showWeekday), value: 0 };
  });

  for (const operation of sales) {
    const date = operationDate(operation);
    if (!date) continue;
    const index = Math.floor((startOfDay(date).getTime() - range.start.getTime()) / 86_400_000);
    if (points[index]) points[index].value += operation.amount;
  }

  return points;
}

function chartAxisLabels(points: SalesChartPoint[], mode: SalesChartMode) {
  if (mode === "hours") return ["00:00", "08:00", "12:00", "16:00", "24:00"];
  if (points.length <= 14) return points.map((point) => point.label);

  const lastIndex = points.length - 1;
  return [0, Math.floor(lastIndex / 3), Math.floor((lastIndex * 2) / 3), lastIndex].map((index) => points[index]?.label ?? "");
}

function SalesChart({ points, mode }: { points: SalesChartPoint[]; mode: SalesChartMode }) {
  const max = Math.max(1, ...points.map((point) => point.value));
  const axisLabels = chartAxisLabels(points, mode);

  return (
    <div className="chartArea">
      <div className="chartLegend">
        <span className="legendToday">Выручка, ₽</span>
      </div>
      <div className="bars" style={{ gridTemplateColumns: `repeat(${points.length}, minmax(0, 1fr))` }}>
        {points.map((point) => (
          <div className="barSlot" key={point.label}>
            <span className="todayBar" style={{ height: `${(point.value / max) * 100}%` }} title={`${point.label}: ${formatMoney(point.value)}`} />
          </div>
        ))}
      </div>
      <div className="chartAxis">
        {axisLabels.map((label, index) => (
          <span key={`${label}-${index}`}>{label}</span>
        ))}
      </div>
    </div>
  );
}

function Donut({ summary }: { summary: DashboardSummary }) {
  const gradient = summary.payments
    .reduce(
      (parts, payment, index) => {
        const start = parts.offset;
        const end = start + payment.percent;
        parts.segments.push(`${paymentColors[payment.kind]} ${start}% ${end}%`);
        parts.offset = end;
        if (index < summary.payments.length - 1) parts.segments.push(`#eef1ee ${end}% ${end + 1}%`);
        return parts;
      },
      { offset: 0, segments: [] as string[] },
    )
    .segments.join(", ");

  return <div className="donut" style={{ background: `conic-gradient(${gradient})` }} />;
}

function AnalyticsScreen({
  summary,
  analytics,
  operations,
  query,
  onQueryChange,
  onBack,
  onRefresh,
}: {
  summary: DashboardSummary;
  analytics: Analytics;
  operations: Operation[];
  query: ReportQuery;
  onQueryChange: (query: ReportQuery) => void;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [range, setRange] = useState<SalesChartMode>("hours");
  const availableModes = useMemo(() => availableSalesChartModes(query), [query]);
  const activeRange = availableModes.includes(range) ? range : availableModes[0];
  const chartPoints = useMemo(() => aggregateSalesChart(operations, query, activeRange), [operations, query, activeRange]);
  const soldItems = useMemo(() => aggregateSoldItems(operations, query), [operations, query]);

  function handleQueryChange(nextQuery: ReportQuery) {
    const nextModes = availableSalesChartModes(nextQuery);
    if (!nextModes.includes(range)) setRange(nextModes[0]);
    onQueryChange(nextQuery);
  }

  return (
    <main className="screen analyticsScreen">
      <AppHeader
        title="Аналитика смены"
        onBack={onBack}
        right={
          <button className="iconButton" aria-label="Календарь">
            <CalendarDays size={21} />
          </button>
        }
      />
      <ReportPeriodControl query={query} onChange={handleQueryChange} />
      <div className="shiftPill">
        <span />
        Отчет: {reportTitle(query).replace("Выручка за ", "")}
      </div>
      <section className="metricsGrid two">
        <MetricCard label="Выручка" value={formatMoney(summary.revenue)} delta={summary.revenueDelta} />
        <MetricCard label="Возвраты" value={formatMoney(analytics.refunds)} delta={analytics.refundsDelta} bad />
      </section>
      <section className="metricsGrid four">
        <MetricCard label="Продажи" value={String(summary.salesCount)} delta={summary.salesDelta} />
        <MetricCard label="Средний чек" value={formatMoney(summary.avgCheck)} delta={summary.avgCheckDelta} />
        <MetricCard label="Средний чек (возвраты)" value={formatMoney(summary.avgRefund)} delta={summary.avgRefundDelta} bad />
        <MetricCard label="Конверсия оплат" value={`${analytics.conversion}%`} delta={analytics.conversionDelta} />
      </section>
      <section className="panel">
        <div className="sectionHead">
          <h2>Динамика продаж</h2>
          <div className="segmented">
            {availableModes.map((mode) => (
              <button key={mode} className={activeRange === mode ? "active" : ""} onClick={() => setRange(mode)}>
                {chartModeLabels[mode]}
              </button>
            ))}
          </div>
        </div>
        <SalesChart points={chartPoints} mode={activeRange} />
      </section>
      <section className="panel soldProductsPanel">
        <div className="sectionHead">
          <h2>Продано товаров и услуг</h2>
        </div>
        <div className="soldProductsList">
          {soldItems.length > 0 ? (
            soldItems.map((item, index) => (
              <div className="soldProductRow" key={item.name}>
                <span className="soldProductRank">{index + 1}</span>
                <span className="soldProductName">{item.name}</span>
                <strong>
                  {item.quantity.toLocaleString("ru-RU")} {item.unit}
                </strong>
                <small>{formatMoney(item.amount)}</small>
              </div>
            ))
          ) : (
            <p className="emptyText">Проданные товары и услуги за период не найдены</p>
          )}
        </div>
      </section>
      <section className="panel paymentsPanel">
        <h2>Способы оплаты</h2>
        <div className="donutRow">
          <Donut summary={summary} />
          <div>
            {summary.payments.map((payment) => (
              <p key={payment.kind}>
                <span style={{ background: paymentColors[payment.kind] }} />
                <strong>{payment.label}</strong>
                <small>
                  {formatMoney(payment.amount)} ({payment.percent}%)
                </small>
              </p>
            ))}
          </div>
        </div>
      </section>
      <footer className="syncBar">
        <span>
          <Check size={17} />
          Данные обновлены {summary.updatedAt}
        </span>
        <button onClick={onRefresh}>
          <RefreshCw size={18} />
          Обновить
        </button>
      </footer>
    </main>
  );
}

export function App() {
  const [view, setView] = useState<View>("welcome");
  const [summary, setSummary] = useState<DashboardSummary | null>(null);
  const [operations, setOperations] = useState<Operation[]>([]);
  const [analytics, setAnalytics] = useState<Analytics | null>(null);
  const [selectedOperationId, setSelectedOperationId] = useState<string | null>(null);
  const [selectedOperationDetails, setSelectedOperationDetails] = useState<Operation | null>(null);
  const [isLoading, setLoading] = useState(false);
  const [loadError, setLoadError] = useState("");
  const [reportQueryState, setReportQueryState] = useState<ReportQuery>({ period: "today" });
  const [userName, setUserName] = useState(getSavedUserName() ?? defaultUserName);

  function resetAuthState() {
    clearSessionToken();
    setUserName(defaultUserName);
    setSummary(null);
    setAnalytics(null);
    setOperations([]);
    setSelectedOperationId(null);
    setSelectedOperationDetails(null);
    setLoadError("");
    setView("welcome");
  }

  async function loadData(query = reportQueryState) {
    setLoading(true);
    setLoadError("");
    try {
      const [summaryData, operationsData, analyticsData] = await Promise.all([
        api.summary(query),
        api.operations(query),
        api.analytics(query),
      ]);
      setSummary(summaryData);
      setOperations(operationsData);
      setAnalytics(analyticsData);
      return true;
    } catch (error) {
      if (isUnauthorizedError(error)) {
        resetAuthState();
        return false;
      }

      setLoadError("Не удалось загрузить данные. Проверь соединение и обнови.");
      return false;
    } finally {
      setLoading(false);
    }
  }

  async function changeReportQuery(query: ReportQuery) {
    setReportQueryState(query);
    await loadData(query);
  }

  async function openOperation(id: string) {
    const cachedOperation = operations.find((operation) => operation.id === id) ?? null;
    const shouldFetchDetails =
      !cachedOperation ||
      ((cachedOperation.kind === "sale" || cachedOperation.kind === "refund" || cachedOperation.kind === "cancel") &&
        !isValidReceiptUrl(cachedOperation.fiscalReceiptUrl));
    setSelectedOperationId(id);
    setSelectedOperationDetails(cachedOperation);
    setView("operation");

    if (shouldFetchDetails) {
      const operation = await api.operation(id).catch(() => null);
      if (operation) setSelectedOperationDetails(operation);
    }
  }

  useEffect(() => {
    if (!hasSessionToken()) return;
    let isMounted = true;
    const deepLinkedOperationId = operationDeepLinkId();

    Promise.all([
      api.summary(reportQueryState),
      api.operations(reportQueryState),
      api.analytics(reportQueryState),
      api.me().catch(() => ({ userName: getSavedUserName() })),
    ])
      .then(([summaryData, operationsData, analyticsData, profileData]) => {
        if (!isMounted) return;
        setSummary(summaryData);
        setOperations(operationsData);
        setAnalytics(analyticsData);
        setUserName(profileData.userName ?? getSavedUserName() ?? defaultUserName);
        if (deepLinkedOperationId) {
          setSelectedOperationId(deepLinkedOperationId);
          setSelectedOperationDetails(operationsData.find((operation) => operation.id === deepLinkedOperationId) ?? null);
          setView("operation");
          return api
            .operation(deepLinkedOperationId)
            .then((operation) => {
              if (isMounted) setSelectedOperationDetails(operation);
            })
            .catch(() => undefined);
        }
        setView("home");
      })
      .catch((error) => {
        if (!isMounted) return;
        if (isUnauthorizedError(error)) {
          resetAuthState();
          return;
        }

        setLoadError("Не удалось загрузить данные. Проверь соединение и обнови.");
        setView("home");
      });

    return () => {
      isMounted = false;
    };
    // The initial restore must use the default report period only once.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useLayoutEffect(() => {
    const resetScroll = () => {
      window.scrollTo({ top: 0, left: 0 });
      document.querySelectorAll(".screen").forEach((element) => element.scrollTo({ top: 0, left: 0 }));
    };

    resetScroll();
    requestAnimationFrame(resetScroll);
  }, [view]);

  const selectedOperation = useMemo(
    () => selectedOperationDetails ?? operations.find((operation) => operation.id === selectedOperationId) ?? (selectedOperationId ? null : operations[0]),
    [operations, selectedOperationDetails, selectedOperationId],
  );

  if (view === "welcome") return <WelcomeScreen onStart={() => setView("login")} />;
  if (view === "login") {
    return (
      <LoginScreen
        onLogin={async (sessionToken, nextUserName) => {
          const displayName = nextUserName ?? defaultUserName;
          setSessionToken(sessionToken, displayName);
          setUserName(displayName);
          const isLoaded = await loadData();
          if (isLoaded || hasSessionToken()) setView("home");
        }}
      />
    );
  }

  if (loadError && (!summary || !analytics)) {
    return (
      <main className="screen loadingScreen">
        <RefreshCw />
        <p>{loadError}</p>
        <button className="primaryButton" onClick={() => void loadData(reportQueryState)}>
          Повторить
        </button>
      </main>
    );
  }

  if (!summary || !analytics || isLoading) {
    return (
      <main className="screen loadingScreen">
        <RefreshCw className="spin" />
        <p>Загружаем продажи...</p>
      </main>
    );
  }

  if (view === "operation" && !selectedOperation) {
    return (
      <main className="screen loadingScreen">
        <RefreshCw className="spin" />
        <p>Загружаем операцию...</p>
      </main>
    );
  }

  if (view === "operation" && selectedOperation) {
    return (
      <OperationScreen
        operation={selectedOperation}
        onBack={() => {
          clearOperationDeepLink();
          setView("home");
        }}
      />
    );
  }

  if (view === "analytics") {
    return (
      <AnalyticsScreen
        summary={summary}
        analytics={analytics}
        operations={operations}
        query={reportQueryState}
        onQueryChange={changeReportQuery}
        onBack={() => setView("home")}
        onRefresh={() => loadData()}
      />
    );
  }

  if (view === "journal") {
    return (
      <JournalScreen
        operations={operations}
        onBack={() => setView("home")}
        onOpenOperation={openOperation}
      />
    );
  }

  return (
    <HomeScreen
      summary={summary}
      analytics={analytics}
      operations={operations}
      userName={userName}
      query={reportQueryState}
      onQueryChange={changeReportQuery}
      onOpenOperation={openOperation}
      onAnalytics={() => setView("analytics")}
      onJournal={() => setView("journal")}
      onLogout={async () => {
        await api.logout().catch(() => undefined);
        resetAuthState();
      }}
      onRefresh={() => loadData()}
    />
  );
}
