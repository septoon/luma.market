export type PaymentKind = "cash" | "card" | "sbp" | "paid" | "notPaid" | "refund" | "cancel" | "unknown";
export type OperationKind = "sale" | "refund" | "cancel" | "shiftOpen" | "shiftClose" | "unknown";
export type ProductSalesPeriod = "today" | "yesterday" | "week";
export type ReportPeriod = "today" | "yesterday" | "week" | "month" | "date";
export type ShiftStatus = "open" | "closed" | "unknown";

export type AuthOrganization = {
  guid: string;
  name: string;
};

export type AuthSessionResponse = {
  sessionToken: string;
  org: AuthOrganization;
  userName?: string;
};

export type AuthLoginResponse = {
  authId?: string;
  sessionToken?: string;
  org?: AuthOrganization;
  userName?: string;
  organizations: AuthOrganization[];
};

export type UserProfileResponse = {
  userName: string | null;
};

export type PushPublicKeyResponse = {
  publicKey: string | null;
  configured: boolean;
  enabled: boolean;
};

export type OperationItem = {
  name: string;
  qty: number;
  unitPrice: number;
  total: number;
};

export type Operation = {
  id: string;
  number: string;
  receiptNumber: string;
  kind: OperationKind;
  amount: number;
  time: string;
  dateTime: string;
  openedAt: string;
  paymentKind: PaymentKind;
  paymentLabel: string;
  cashbox: string;
  cashier: string;
  receiptStatus: "sent" | "pending" | "failed";
  items: OperationItem[];
  subtotal: number;
  discount: number;
  rawType?: string;
  fiscalReceiptUrl?: string;
  fiscalDocumentGuid?: string;
  fiscalRegistrarGuid?: string;
};

export type DashboardSummary = {
  revenue: number;
  revenueDelta: number | null;
  salesCount: number;
  salesDelta: number | null;
  avgCheck: number;
  avgCheckDelta: number | null;
  avgRefund: number;
  avgRefundDelta: number | null;
  shiftStatus: ShiftStatus;
  shiftOpenedAt: string;
  shiftClosedAt: string | null;
  shiftDuration: string;
  cashbox: string;
  payments: Array<{
    kind: PaymentKind;
    label: string;
    amount: number;
    percent: number;
  }>;
  updatedAt: string;
};

export type Analytics = {
  refunds: number;
  refundsDelta: number | null;
  conversion: number;
  conversionDelta: number | null;
  hourly: Array<{
    hour: string;
    today: number;
    yesterday: number;
  }>;
  soldItemsByPeriod: Record<
    ProductSalesPeriod,
    Array<{
      name: string;
      quantity: number;
      unit: string;
      amount: number;
    }>
  >;
};
