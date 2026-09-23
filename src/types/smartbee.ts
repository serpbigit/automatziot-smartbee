// SmartBee API types - source: SMARTBEE-API-INTEGRATION.md (last updated 2026-04-26)
// Base URLs: test https://test.smartbee.co.il/api/v1 | prod https://smartbee.co.il/api/v1
// Flow: POST /login/authenticate -> JWT (Bearer, 7 days) -> POST /documents/create -> poll GET /documents/{msgId}
// providerUserToken goes in the BODY of every business request. Users/loginToken is NOT used.

export const SMARTBEE_BASE_URL = {
  test: "https://test.smartbee.co.il/api/v1",
  prod: "https://smartbee.co.il/api/v1",
} as const;

// ---------- Auth ----------
export interface LoginDto {
  clientId: string;
  password: string;
}

export interface LoginResponse {
  token: string;
  expirationUtcDate: string; // ISO 8601
}

// ---------- Envelope & result codes ----------
export interface SmartBeeEnvelope<T> {
  resultCodeId: ResultCode;
  result: T | null;
  validationErrors: Record<string, string> | null;
}

export enum ResultCode {
  MsgProcessing = 1,
  UnauthorizedRequest = 94,
  DuplicatedMessage = 95,
  MsgRequestValidationError = 96,
  InvalidMsgId = 97,
  InvalidCredentials = 98,
  GeneralError = 99,
  DocCreationRequestCreated = 101,
  DocCreated = 102,
  DraftCreated = 103,
  DocCreationDisabled = 104,
  DocSearchSuccessful = 120,
  DocUpdateSuccessful = 140,
  DocUpdateError = 197,
  DocSearchError = 198,
  DocCreationError = 199,
  ExpensesSearchSuccessful = 320,
  ExpenseNotFound = 380,
  ExpenseFileNotFound = 385,
  ExpensesSearchError = 390,
}

export const POLL_CONTINUE_CODES = [ResultCode.MsgProcessing, ResultCode.DocCreationRequestCreated];
export const POLL_SUCCESS_CODES = [ResultCode.DocCreated, ResultCode.DraftCreated];

export interface RequestBase {
  providerUserToken: string;
}

// ---------- Enums (sent as strings) ----------
export type DocumentType =
  | "InvoiceReceipt" | "Receipt" | "ReceiptRefund" | "Invoice" | "RefundInvoice"
  | "DealInvoice" | "PriceProposal" | "OrderConfirmation" | "ShippingCertificate"
  | "DonationReceipt" | "ReturnCertificate";

export type VatOptionType = "NotInclude" | "Include" | "Free";
export type DiscountValueType = "Percentage" | "DirectAmount";
export type CurrencyType = "ILS" | "USD" | "EUR" | "GBP" | "CHF" | "CAD" | "JPY" | "AUD" | "DKK" | "NOK" | "SEK";
export type CreditCardType = "Isracard" | "Visa" | "Diners" | "AmericanExpress" | "Mastercard" | "Other";
export type CreditDealType = "Regular" | "Installments" | "Credit" | "DeferredDebit" | "Other";
export type SortDirection = "Ascending" | "Descending";

// ---------- Customer ----------
export interface Customer {
  name: string;                 // required, 2-100 chars
  providerCustomerId?: string;  // stable ID: first use stores details, later uses auto-identify
  email?: string;
  mainPhone?: string;
  seconderyPhone?: string;      // sic - API field name is misspelled
  dealerNumber?: string;
  address?: string;             // 4-30 chars
  cityName?: string;            // 2-30 chars
  contactName?: string;         // 2-100 chars
  comments?: string;            // max 1024
  netEOM?: number;
  accountNumber?: string;
  bankName?: string;
  branchName?: string;
  journalAccount?: number;
}

// ---------- Document items ----------
export interface PaymentItem {
  description: string;          // required, 1-500 chars
  quantity: number;             // -99,999.9 .. 9,999,999.9
  pricePerUnit: number;         // 0 .. 9,999,999.9
  vatOption: VatOptionType;
  providerItemId?: string;
  catNum?: string;
}

export interface Discount {
  discountValueType: DiscountValueType;
  value: number;
}

export interface DocumentItems {
  paymentItems: PaymentItem[];
  discount?: Discount;
  roundTotalSum?: boolean;
}

// ---------- Receipt details (receipt-type docs only) ----------
export interface CreditCardItem {
  creditCardType: CreditCardType;
  cardNumber: string;           // last 4-6 digits
  creditDealType: CreditDealType;
  installmentsNumber: number;   // 1-99
  firstInstallment?: number | null;
  voucherNumber?: string;
  date: string;
  sum: number;
}

export interface CheckItem {
  accountNumber: string;
  bankName: string;
  branchName: string;
  checkId: string;
  date: string;
  sum: number;
}

export interface WireTransferItem {
  accountNumber: string;
  referenceNum: string;
  bankName: string;
  branchName: string;
  date: string;
  sum: number;
}

export interface CashItem { date: string; sum: number; }
export interface OtherReceiptItem { description: string; date: string; sum: number; }

export interface ReceiptDetailsRequest {
  creditCardItems?: CreditCardItem[];
  checkItems?: CheckItem[];
  wireTransferItems?: WireTransferItem[];
  cashItems?: CashItem[];
  otherItems?: OtherReceiptItem[];
  taxWithholding?: number;      // receipt total = all payments + taxWithholding, must equal invoice total (+-0.1)
}

// ---------- Create document ----------
export interface Currency {
  currencyType: CurrencyType;
  rate?: number | null;
}

export interface CreationMetadata {
  language?: "HEB" | "ENG";
  currencyTarget?: CurrencyType;
  sendOriginalToCustomer?: boolean; // defaults TRUE if customer has email - set false in tests
}

export interface DocumentRequest extends RequestBase {
  providerMsgId: string;          // idempotency key (UUID); reuse on retry
  providerMsgReferenceId: string;
  customer: Customer;
  docType: DocumentType;
  documentItems?: DocumentItems;          // required for invoice/quote types
  receiptDetails?: ReceiptDetailsRequest; // required for *Receipt* types
  createDraftOnFailure?: boolean;
  isDraft?: boolean;
  dueDate?: string;
  docDate?: string;               // must be >= latest doc of same type
  comments?: string;              // max 5024
  title?: string;                 // max 100
  extraCommentsForEmail?: string; // max 1024
  currency?: Currency;
  incomeClassName?: string;
  creationMetadata?: CreationMetadata;
}

// POST /documents/create -> result = message ID (string), resultCodeId 101
export type CreateDocumentResponse = SmartBeeEnvelope<string>;

// GET /documents/{msgId}
export interface DocumentCreatedResult {
  docType: DocumentType;
  documentId: string;
  index: number;
  linkToOriginal: string;
  linkToCopy: string;
}

export interface DraftCreatedResult {
  docType: DocumentType;
  draftDocumentId: string;
}

export type PollDocumentResponse = SmartBeeEnvelope<DocumentCreatedResult | DraftCreatedResult>;

// ---------- Search / update ----------
export interface DocumentsSearchRequest extends RequestBase {
  page?: number;
  amountPerPage?: number;
  sortingField?: string;
  sortDirection?: SortDirection;
  producibleDocumentType?: DocumentType;
  fromDate?: string;
  toDate?: string;
  createdFromDate?: string;
  createdToDate?: string;
  fromSum?: number;
  toSum?: number;
  city?: string;
  catalogItemName?: string;
  isHandled?: boolean;
  includeDeleted?: boolean;
  documentIndex?: number;
}

export interface DocumentSearchItem {
  id: string;
  creationDate: string;
  index: number;
  docType: DocumentType;
  taxConfirmationNumber?: string;
  linkToOriginal: string;
  linkToCopy: string;
  invoiceDetails?: Record<string, unknown>;
  receiptDetails?: Record<string, unknown>;
  customer?: Partial<Customer>;
  documentItems?: Record<string, unknown>;
}

export interface PagedResult<T> {
  totalItemCount: number;
  page: number;
  amountPerPage: number;
  items: T[];
  status: string;
}

export type DocumentsSearchResponse = SmartBeeEnvelope<PagedResult<DocumentSearchItem>>;

export interface DocumentUpdateRequest extends RequestBase {
  documentId: string;
  isHandled: boolean;
}

export type DocumentUpdateResponse = SmartBeeEnvelope<{ status: string }>;
