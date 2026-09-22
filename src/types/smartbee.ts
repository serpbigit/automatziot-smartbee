export type DocumentType =
  | "InvoiceReceipt"
  | "Receipt"
  | "ReceiptCancellation"
  | "ReceiptRefund"
  | "Invoice"
  | "RefundInvoice"
  | "DealInvoice"
  | "PriceProposal"
  | "OrderConfirmation"
  | "ShippingCertificate"
  | "DonationReceipt"
  | "DonationReceiptCancellation"
  | "ReturnCertificate";

export type CurrencyType =
  | "ILS"
  | "USD"
  | "EUR"
  | "GBP"
  | "CHF"
  | "CAD"
  | "JPY"
  | "AUD"
  | "DKK"
  | "NOK"
  | "SEK";

export type VatOptionType = "NotInclude" | "Include" | "Free";
export type DiscountType = "Percentage" | "DirectAmount";
export type Language = "HEB" | "ENG";

export interface SmartBeeCustomer {
  name: string;
  providerCustomerId?: string;
  email?: string;
  mainPhone?: string;
  dealerNumber?: string;
  address?: string;
  cityName?: string;
  seconderyPhone?: string;
  contactName?: string;
  comments?: string;
  netEOM?: number;
  accountNumber?: string;
  bankName?: string;
  branchName?: string;
  journalAccount?: number;
}

export interface SmartBeePaymentItem {
  description: string;
  quantity: number;
  pricePerUnit: number;
  vatOption: VatOptionType;
  providerItemId?: string;
  catNum?: string;
}

export interface SmartBeeDiscount {
  discountValueType: DiscountType;
  value: number;
}

export interface SmartBeeDocumentItems {
  paymentItems: SmartBeePaymentItem[];
  discount?: SmartBeeDiscount;
  roundTotalSum?: boolean;
}

export interface SmartBeeCurrency {
  currencyType: CurrencyType;
  rate?: number;
}

export interface SmartBeeCreationMetadata {
  language?: Language;
  currencyTarget?: CurrencyType;
  sendOriginalToCustomer?: boolean;
}

export interface SmartBeeReceiptDetails {
  checkItems?: unknown[];
  wireTransferItems?: unknown[];
  creditCardItems?: unknown[];
  cashItems?: unknown[];
  otherItems?: unknown[];
  taxWithholding?: number;
}

/** Fields the caller supplies. providerUserToken/providerMsgId/providerMsgReferenceId
 *  are filled in automatically by createSmartBeeDocument. */
export interface SmartBeeDocumentRequest {
  customer: SmartBeeCustomer;
  docType: DocumentType;
  docDate?: string;
  dueDate?: string;
  comments?: string;
  title?: string;
  extraCommentsForEmail?: string;
  createDraftOnFailure?: boolean;
  isDraft?: boolean;
  incomeClassName?: string;
  currency?: SmartBeeCurrency;
  documentItems?: SmartBeeDocumentItems;
  receiptDetails?: SmartBeeReceiptDetails;
  creationMetadata?: SmartBeeCreationMetadata;
}

export interface SmartBeeDocumentCreateResponse {
  docType: DocumentType;
  documentId?: string | null;
  draftDocumentId?: string | null;
  index?: number;
  taxConfirmationNumber?: string | null;
  linkToOriginal?: string | null;
  linkToCopy?: string | null;
}

export interface SmartBeeApiResponse<T> {
  resultCodeId: number;
  result: T;
  validationErrors?: Record<string, unknown> | null;
}
