export type PaymentKind = "cash" | "card" | "sbp" | "paid" | "notPaid" | "unknown";
export type OperationKind = "sale" | "refund";
export type ProductSalesPeriod = "today" | "yesterday" | "week";
export type ReportPeriod = "today" | "yesterday" | "week" | "month" | "date";

export type ReportRange = {
  period: ReportPeriod;
  date?: string;
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
};

export type DashboardSummary = {
  revenue: number;
  revenueDelta: number;
  salesCount: number;
  salesDelta: number;
  avgCheck: number;
  avgCheckDelta: number;
  avgRefund: number;
  avgRefundDelta: number;
  shiftOpenedAt: string;
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
  refundsDelta: number;
  conversion: number;
  conversionDelta: number;
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
