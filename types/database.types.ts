export type Json =
  | string
  | number
  | boolean
  | null
  | { [key: string]: Json | undefined }
  | Json[];

// ============================================================================
// ENUMS
// ============================================================================

export type VerificationStatus =
  | "pending"
  | "verified"
  | "rejected"
  | "suspended";
export type AccountStatus = "active" | "blocked" | "suspended" | "closed";
export type UserAccountType = "personal" | "business";
export type TransactionStatus =
  | "pending"
  | "processing"
  | "completed"
  | "failed"
  | "reversed"
  | "cancelled";
export type PaymentMethod = "alias" | "cvu" | "cbu" | "qr";
export type TransactionCategory = "income" | "expense" | "internal";
export type QRType = "static" | "dynamic";
export type DeviceStatus = "active" | "inactive" | "revoked";
export type DevicePlatform = "ios" | "android" | "web";

// ============================================================================
// TABLAS
// ============================================================================

export interface User {
  id: string;
  first_name: string;
  last_name: string;
  email: string;
  phone: string;
  dni: string;
  cuit_cuil: string;
  pin_hash: string;
  web_access_enabled: boolean;
  web_password_hash: string | null;
  web_access_enabled_at: string | null;
  verification_status: VerificationStatus;
  account_type: UserAccountType;
  /** Motivo del estado (ej. motivo de rechazo). 'pending_approval' mientras espera revisión */
  status_reason: string | null;
  zapsign_verification_id: string | null;
  zapsign_verified_at: string | null;
  zapsign_data: Json | null;
  photo_url: string | null;
  created_at: string;
  updated_at: string;
  /** Solo para account_type = 'business' (embed de business_profiles) */
  business_profile?: BusinessProfile | null;
}

export interface BusinessProfile {
  user_id: string;
  cuit: string;
  incorporation_date: string;
  legal_entity_type: string;
  legal_name: string;
  trade_name: string | null;
  created_at: string;
  updated_at: string;
  /** Embed de legal_entity_types */
  legal_entity?: { name: string } | null;
}

export interface LegalEntityType {
  code: string;
  name: string;
  sort_order: number;
  is_active: boolean;
}

export interface Account {
  id: string;
  user_id: string;
  account_type_id: string;
  cbu: string;
  cvu: string;
  alias: string;
  balance: number;
  status: AccountStatus;
  status_reason: string | null;
  is_primary: boolean;
  account_number: number;
  created_at: string;
  updated_at: string;
  closed_at: string | null;
}

export interface AccountType {
  id: string;
  code: string;
  name: string;
  currency: string;
  description: string | null;
  is_active: boolean;
  allows_overdraft: boolean;
  overdraft_limit: number;
  created_at: string;
}

export interface Transaction {
  id: string;
  transaction_type_id: string;
  from_account_id: string | null;
  to_account_id: string | null;
  external_cvu: string | null;
  external_cbu: string | null;
  external_alias: string | null;
  external_holder_name: string | null;
  amount: number;
  currency: string;
  concept: string | null;
  payment_method: PaymentMethod;
  payment_reference: string;
  status: TransactionStatus;
  commission_amount: number;
  net_amount: number;
  processed_by: string;
  failure_reason: string | null;
  reference_number: string;
  metadata: Json | null;
  initiated_from_device_id: string | null;
  initiated_from_ip: string | null;
  created_at: string;
  processing_at: string | null;
  completed_at: string | null;
  failed_at: string | null;
}

export interface TransactionType {
  id: string;
  code: string;
  name: string;
  description: string | null;
  category: TransactionCategory;
  is_active: boolean;
  requires_destination: boolean;
  commission_rate: number;
  min_commission: number;
  max_commission: number | null;
  created_at: string;
}

export interface AccountLimit {
  id: string;
  account_id: string;
  monthly_limit: number;
  monthly_spent: number;
  monthly_available: number;
  current_period_start: string;
  current_period_end: string;
  daily_limit: number | null;
  daily_spent: number;
  per_transaction_limit: number | null;
  updated_at: string;
}

export interface QRCode {
  id: string;
  account_id: string;
  qr_data: string;
  qr_hash: string;
  qr_type: QRType;
  amount: number | null;
  concept: string | null;
  expires_at: string | null;
  max_uses: number | null;
  is_active: boolean;
  times_used: number;
  last_used_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface UserDevice {
  id: string;
  user_id: string;
  device_id: string;
  device_name: string | null;
  device_model: string | null;
  platform: DevicePlatform;
  os_version: string | null;
  app_version: string | null;
  push_token: string | null;
  status: DeviceStatus;
  is_primary: boolean;
  biometric_enabled: boolean;
  last_active_at: string;
  registered_at: string;
  revoked_at: string | null;
  revoke_reason: string | null;
}

export interface ApiAccess {
  id: string;
  user_id: string;
  is_enabled: boolean;
  api_username: string;
  api_password_hash: string;
  allowed_ips: string[];
  last_access_at: string | null;
  created_at: string;
  updated_at: string;
}

export interface AuditLog {
  id: string;
  user_id: string | null;
  entity_type: string;
  entity_id: string;
  action: string;
  changes: Json | null;
  ip_address: string | null;
  user_agent: string | null;
  created_at: string;
}

export interface UserAuthCredential {
  id: string;
  user_id: string;
  auto_password_encrypted: string;
  encryption_key_id: string | null;
  created_at: string;
  updated_at: string;
}

// ============================================================================
// VISTAS
// ============================================================================

export interface AccountMovement {
  account_id: string;
  user_id: string;
  transaction_id: string;
  created_at: string;
  completed_at: string | null;
  amount: number;
  concept: string | null;
  payment_method: PaymentMethod;
  reference_number: string;
  category: TransactionCategory;
  transaction_type_name: string;
  movement_type: "income" | "expense" | "other";
  income_amount: number;
  expense_amount: number;
  status: TransactionStatus;
  counterpart_name: string | null;
}

// ============================================================================
// TIPOS EXTENDIDOS (para joins)
// ============================================================================

export interface AccountWithType extends Account {
  account_types: AccountType;
}

export interface TransactionWithType extends Transaction {
  transaction_types: TransactionType;
}

export interface AccountWithLimits extends Account {
  account_limits: AccountLimit | null;
}

export interface UserWithAccount extends User {
  accounts: Account[];
}

// ============================================================================
// TIPOS PARA FUNCIONES RPC
// ============================================================================

export interface ProcessTransferArgs {
  p_from_account_id: string;
  p_to_identifier: string;
  p_amount: number;
  p_concept?: string;
  p_payment_method?: PaymentMethod;
  p_device_id?: string;
  p_ip_address?: string;
}

export interface ProcessTransferResult {
  success: boolean;
  transaction_id: string;
  amount: number;
  new_balance: number;
  is_external: boolean;
  to_account_id: string | null;
  reference_number: string;
}

export interface ValidateTransferArgs {
  p_from_account_id: string;
  p_to_identifier: string;
  p_amount: number;
  p_payment_method?: PaymentMethod;
}

export interface ValidateTransferResult {
  valid: boolean;
  error_code: string | null;
  error_message: string | null;
  to_account_id: string | null;
  to_holder_name: string | null;
  is_external: boolean;
  commission_amount: number;
  net_amount: number;
}

export interface GetUserLoginDataArgs {
  email_input: string;
}

export interface GetUserLoginDataResult {
  id: string;
  email: string;
  pin_hash: string;
  verification_status: VerificationStatus;
  auto_password_encrypted: string | null;
}

export interface SearchAccountArgs {
  p_identifier: string;
}

export interface SearchAccountResult {
  account_id: string | null;
  holder_name: string;
  alias: string | null;
  is_external: boolean;
}

export interface AppVersion {
  id: number;
  version: string;
  build_number: number | null;
  platform: "ios" | "android";
  mandatory: boolean;
  store_url: string | null;
  created_at: string;
}

// ============================================================================
// DATABASE TYPE (para Supabase Client)
// ============================================================================

export interface Database {
  public: {
    Tables: {
      users: {
        Row: User;
        Insert: { id: string } & Omit<User, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<User, "id" | "created_at">>;
      };
      accounts: {
        Row: Account;
        Insert: Omit<
          Account,
          "id" | "created_at" | "updated_at" | "account_number"
        >;
        Update: Partial<Omit<Account, "id" | "created_at" | "account_number">>;
      };
      account_types: {
        Row: AccountType;
        Insert: Omit<AccountType, "id" | "created_at">;
        Update: Partial<Omit<AccountType, "id" | "created_at">>;
      };
      transactions: {
        Row: Transaction;
        Insert: Omit<Transaction, "id" | "created_at" | "reference_number">;
        Update: Partial<
          Omit<Transaction, "id" | "created_at" | "reference_number">
        >;
      };
      transaction_types: {
        Row: TransactionType;
        Insert: Omit<TransactionType, "id" | "created_at">;
        Update: Partial<Omit<TransactionType, "id" | "created_at">>;
      };
      account_limits: {
        Row: AccountLimit;
        Insert: Omit<AccountLimit, "id" | "monthly_available" | "updated_at">;
        Update: Partial<Omit<AccountLimit, "id" | "monthly_available">>;
      };
      qr_codes: {
        Row: QRCode;
        Insert: Omit<QRCode, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<QRCode, "id" | "created_at">>;
      };
      user_devices: {
        Row: UserDevice;
        Insert: Omit<UserDevice, "id" | "registered_at">;
        Update: Partial<Omit<UserDevice, "id" | "registered_at">>;
      };
      api_access: {
        Row: ApiAccess;
        Insert: Omit<ApiAccess, "id" | "created_at" | "updated_at">;
        Update: Partial<Omit<ApiAccess, "id" | "created_at">>;
      };
      audit_logs: {
        Row: AuditLog;
        Insert: Omit<AuditLog, "id" | "created_at">;
        Update: never;
      };
      user_auth_credentials: {
        Row: UserAuthCredential;
        Insert: Omit<UserAuthCredential, "id" | "created_at" | "updated_at"> & {
          encryption_key_id?: string | null;
        };
        Update: Partial<Omit<UserAuthCredential, "id" | "created_at">>;
      };
      app_versions: {
        Row: AppVersion;
        Insert: Omit<AppVersion, "id" | "created_at">;
        Update: Partial<Omit<AppVersion, "id" | "created_at">>;
      };
    };
    Views: {
      account_movements: {
        Row: AccountMovement;
      };
    };
    Functions: {
      process_transfer: {
        Args: ProcessTransferArgs;
        Returns: ProcessTransferResult;
      };
      validate_transfer: {
        Args: ValidateTransferArgs;
        Returns: ValidateTransferResult;
      };
      get_user_login_data: {
        Args: GetUserLoginDataArgs;
        Returns: GetUserLoginDataResult[];
      };
      get_account_info: {
        Args: { p_user_id?: string };
        Returns: AccountWithType[];
      };
      search_account_for_transfer: {
        Args: SearchAccountArgs;
        Returns: SearchAccountResult[];
      };
    };
    Enums: {
      verification_status: VerificationStatus;
      account_status: AccountStatus;
      transaction_status: TransactionStatus;
      payment_method: PaymentMethod;
      transaction_category: TransactionCategory;
      qr_type: QRType;
      device_status: DeviceStatus;
      device_platform: DevicePlatform;
    };
  };
}

// ============================================================================
// HELPERS DE TIPOS
// ============================================================================

// Tipos para extraer Row de una tabla
export type Tables<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Row"];

// Tipos para extraer Insert de una tabla
export type TablesInsert<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Insert"];

// Tipos para extraer Update de una tabla
export type TablesUpdate<T extends keyof Database["public"]["Tables"]> =
  Database["public"]["Tables"][T]["Update"];

// Tipos para extraer Views
export type Views<T extends keyof Database["public"]["Views"]> =
  Database["public"]["Views"][T]["Row"];

// Tipos para extraer Enums
export type Enums<T extends keyof Database["public"]["Enums"]> =
  Database["public"]["Enums"][T];
