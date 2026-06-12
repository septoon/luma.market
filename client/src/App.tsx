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
import { FormEvent, ReactNode, useEffect, useLayoutEffect, useMemo, useState } from "react";
import { api, clearSessionToken, getSavedUserName, hasSessionToken, setSessionToken, type ReportQuery } from "./api";
import type { Analytics, AuthOrganization, DashboardSummary, Operation, PaymentKind, ProductSalesPeriod, ReportPeriod } from "./types";

type View = "welcome" | "login" | "home" | "operation" | "analytics" | "journal" | "returns";
type JournalPeriod = "today" | "yesterday" | "week" | "all";

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
  unknown: "#c7d1ca",
};

const productPeriodLabels: Record<ProductSalesPeriod, string> = {
  today: "Период",
  yesterday: "До",
  week: "7 дней",
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

function isEnvPreviewMode() {
  return import.meta.env.DEV && new URLSearchParams(window.location.search).get("preview") === "env";
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
          return;
        }

        const registration = await navigator.serviceWorker.ready;
        const subscription = await registration.pushManager.getSubscription();
        if (!isMounted) return;

        if (subscription) {
          await api.savePushSubscription(subscription.toJSON());
          setState("enabled");
          return;
        }

        setState("ready");
      } catch {
        if (isMounted) setState("error");
      }
    }

    loadState();
    return () => {
      isMounted = false;
    };
  }, []);

  async function enableNotifications() {
    if (!supportsPushNotifications()) return;
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
        return;
      }

      const registration = await navigator.serviceWorker.ready;
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
      const registration = await navigator.serviceWorker.ready;
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

  const disabled = state === "loading" || state === "unsupported" || state === "unconfigured" || state === "denied";
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
      title={message ?? label}
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

function Delta({ value, tone = "good" }: { value: number; tone?: "good" | "bad" }) {
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
  delta: number;
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
  const isRefund = operation.kind === "refund";
  return (
    <button className="operationRow" onClick={onOpen}>
      <span className={isRefund ? "rowIcon refund" : "rowIcon"}>
        {isRefund ? <RotateCcw size={18} /> : <Receipt size={18} />}
      </span>
      <span className="rowMain">
        <strong>{isRefund ? "Возврат" : "Продажа"}</strong>
        <small>№ {operation.number}</small>
      </span>
      <span className="rowTime">{operation.time}</span>
      <strong className={isRefund ? "amount refundText" : "amount"}>
        {isRefund ? "− " : ""}
        {formatMoney(Math.abs(operation.amount))}
      </strong>
      <ChevronRight size={18} className="mutedIcon" />
    </button>
  );
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
  return (
    <main className="screen">
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
          <div className="deltaPill" aria-label={comparisonLabel(query)}>
            <Delta value={summary.revenueDelta} />
            <small>{comparisonLabel(query)}</small>
          </div>
        </div>
      </section>
      <section className="metricsGrid three">
        <MetricCard label="Количество продаж" value={String(summary.salesCount)} delta={summary.salesDelta} />
        <MetricCard label="Средний чек" value={formatMoney(summary.avgCheck)} delta={summary.avgCheckDelta} />
        <MetricCard label="Средний чек (возвраты)" value={`− ${formatMoney(summary.avgRefund)}`} delta={summary.avgRefundDelta} bad />
      </section>
      <section className="panel shiftPanel">
        <div>
          <h2>Смена</h2>
          <p>Началась в {summary.shiftOpenedAt}</p>
          <p>Касса: {summary.cashbox}</p>
        </div>
        <div className="shiftStatus">
          <span>Открыта</span>
        </div>
      </section>
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
      <nav className="bottomActions" aria-label="Основные действия">
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
  const total = visibleOperations.reduce((sum, operation) => sum + (operation.kind === "refund" ? -operation.amount : operation.amount), 0);

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
          <span className="readonlyTag">Только чтение</span>
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
  const statusLabel =
    operation.receiptStatus === "sent" ? "Чек отправлен" : operation.receiptStatus === "failed" ? "Ошибка чека" : "Чек ожидает данных";

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
      <section className="operationAmount panel">
        <span>Сумма операции</span>
        <div>
          <h1>{formatMoney(operation.amount)}</h1>
          <strong className={operation.receiptStatus === "failed" ? "statusBadge statusBad" : "statusBadge"}>
            {statusLabel} <Check size={16} />
          </strong>
        </div>
      </section>
      <section className="panel infoList">
        <InfoLine icon={<CreditCard size={18} />} label="Способ оплаты" value={operation.paymentLabel} />
        <InfoLine icon={<Store size={18} />} label="Касса" value={operation.cashbox} />
        <InfoLine icon={<UserRound size={18} />} label="Кассир" value={operation.cashier} />
        <InfoLine icon={<Clock3 size={18} />} label="Дата и время" value={operation.dateTime} />
        <InfoLine icon={<WalletCards size={18} />} label="Номер операции" value={`№ ${operation.number}`} />
        <InfoLine icon={<Receipt size={18} />} label="Номер чека" value={`№ ${operation.receiptNumber}`} />
      </section>
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
      <p className="readonlyNotice">Режим только чтение: приложение не изменяет продажи, возвраты, смены или кассу.</p>
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

function SalesChart({ analytics }: { analytics: Analytics }) {
  const max = Math.max(...analytics.hourly.flatMap((point) => [point.today, point.yesterday]));

  return (
    <div className="chartArea">
      <div className="chartLegend">
        <span className="legendToday">Выручка, ₽</span>
        <span className="legendYesterday">Вчера</span>
      </div>
      <div className="bars">
        {analytics.hourly.map((point) => (
          <div className="barSlot" key={point.hour}>
            <span className="yesterdayMark" style={{ height: `${(point.yesterday / max) * 100}%` }} />
            <span className="todayBar" style={{ height: `${(point.today / max) * 100}%` }} />
          </div>
        ))}
      </div>
      <div className="chartAxis">
        <span>00:00</span>
        <span>08:00</span>
        <span>12:00</span>
        <span>16:00</span>
        <span>24:00</span>
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
  query,
  onQueryChange,
  onBack,
  onRefresh,
}: {
  summary: DashboardSummary;
  analytics: Analytics;
  query: ReportQuery;
  onQueryChange: (query: ReportQuery) => void;
  onBack: () => void;
  onRefresh: () => void;
}) {
  const [range, setRange] = useState<"hours" | "days" | "weeks">("hours");
  const [productPeriod, setProductPeriod] = useState<ProductSalesPeriod>("today");
  const soldItems = analytics.soldItemsByPeriod[productPeriod];

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
      <ReportPeriodControl query={query} onChange={onQueryChange} />
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
            <button className={range === "hours" ? "active" : ""} onClick={() => setRange("hours")}>
              Часы
            </button>
            <button className={range === "days" ? "active" : ""} onClick={() => setRange("days")}>
              Дни
            </button>
            <button className={range === "weeks" ? "active" : ""} onClick={() => setRange("weeks")}>
              Недели
            </button>
          </div>
        </div>
        <SalesChart analytics={analytics} />
      </section>
      <section className="panel soldProductsPanel">
        <div className="sectionHead">
          <h2>Продано товаров и услуг</h2>
          <div className="segmented periodSegment">
            {(Object.keys(productPeriodLabels) as ProductSalesPeriod[]).map((period) => (
              <button
                key={period}
                className={productPeriod === period ? "active" : ""}
                onClick={() => setProductPeriod(period)}
              >
                {productPeriodLabels[period]}
              </button>
            ))}
          </div>
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
  const [isLoading, setLoading] = useState(false);
  const [reportQueryState, setReportQueryState] = useState<ReportQuery>({ period: "today" });
  const [userName, setUserName] = useState(getSavedUserName() ?? defaultUserName);

  async function loadData(query = reportQueryState) {
    setLoading(true);
    try {
      const [summaryData, operationsData, analyticsData] = await Promise.all([
        api.summary(query),
        api.operations(query),
        api.analytics(query),
      ]);
      setSummary(summaryData);
      setOperations(operationsData);
      setAnalytics(analyticsData);
    } finally {
      setLoading(false);
    }
  }

  async function changeReportQuery(query: ReportQuery) {
    setReportQueryState(query);
    await loadData(query);
  }

  useEffect(() => {
    if (!hasSessionToken() && !isEnvPreviewMode()) return;
    let isMounted = true;

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
        setView("home");
      })
      .catch(() => {
        if (!isMounted) return;
        clearSessionToken();
        setView("welcome");
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
    () => operations.find((operation) => operation.id === selectedOperationId) ?? operations[0],
    [operations, selectedOperationId],
  );

  if (view === "welcome") return <WelcomeScreen onStart={() => setView("login")} />;
  if (view === "login") {
    return (
      <LoginScreen
        onLogin={async (sessionToken, nextUserName) => {
          const displayName = nextUserName ?? defaultUserName;
          setSessionToken(sessionToken, displayName);
          setUserName(displayName);
          await loadData();
          setView("home");
        }}
      />
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

  if (view === "operation" && selectedOperation) {
    return <OperationScreen operation={selectedOperation} onBack={() => setView("home")} />;
  }

  if (view === "analytics") {
    return (
      <AnalyticsScreen
        summary={summary}
        analytics={analytics}
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
        onOpenOperation={(id) => {
          setSelectedOperationId(id);
          setView("operation");
        }}
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
      onOpenOperation={(id) => {
        setSelectedOperationId(id);
        setView("operation");
      }}
      onAnalytics={() => setView("analytics")}
      onJournal={() => setView("journal")}
      onLogout={() => {
        clearSessionToken();
        setUserName(defaultUserName);
        setSummary(null);
        setView("welcome");
      }}
      onRefresh={() => loadData()}
    />
  );
}
