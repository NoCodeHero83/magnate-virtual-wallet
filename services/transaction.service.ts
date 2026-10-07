import { supabase } from "../lib/supabase";
import { getDeviceDescriptor } from "./auth.service";
import {
  Transaction,
  TransactionWithType,
  AccountMovement,
  SearchAccountResult,
} from "../types/database.types";

/** Lo que cuesta una transferencia antes de confirmarla (lo calcula el servidor) */
export interface TransferQuote {
  fee: number;
  chargeMode: "deduct" | "on_top";
  /** Lo que se debita de la cuenta */
  totalDebit: number;
  /** Lo que sale hacia el destino */
  amountSent: number;
}

export const transactionService = {
  /**
   * Comisión de una transferencia antes de confirmarla.
   * Devuelve null si no se pudo calcular (la transferencia igual la valida el servidor).
   */
  async quoteTransfer(
    fromAccountId: string,
    toIdentifier: string,
    amount: number,
  ): Promise<TransferQuote | null> {
    const { data, error } = await supabase.rpc("quote_transfer", {
      p_from_account_id: fromAccountId,
      p_to_identifier: toIdentifier.trim(),
      p_amount: amount,
    } as any);
    const result = data as any;
    if (error || !result?.success) {
      if (error) console.error("Error quoting transfer:", error);
      return null;
    }
    return {
      fee: Number(result.fee) || 0,
      chargeMode: result.charge_mode,
      totalDebit: Number(result.total_debit) || amount,
      amountSent: Number(result.amount_sent) || amount,
    };
  },

  /**
   * Get recent transactions for dashboard
   */
  async getRecentTransactions(
    accountId: string,
    limit: number = 5,
  ): Promise<TransactionWithType[]> {
    const { data, error } = await supabase
      .from("transactions")
      .select(
        `
                *,
                transaction_types (*)
            `,
      )
      .or(`from_account_id.eq.${accountId},to_account_id.eq.${accountId}`)
      .order("created_at", { ascending: false })
      .limit(limit);

    if (error) {
      console.error("Error fetching recent transactions:", error);
      throw error;
    }

    return data as TransactionWithType[];
  },

  /**
   * Get all movements (using the view account_movements)
   */
  async getAccountMovements(
    accountId: string,
    limit: number = 20,
    offset: number = 0,
    filters?: {
      startDate?: Date;
      endDate?: Date;
      type?: "income" | "expense";
    },
  ): Promise<AccountMovement[]> {
    let query = supabase
      .from("account_movements")
      .select("*")
      .eq("account_id", accountId)
      .order("created_at", { ascending: false })
      .range(offset, offset + limit - 1);

    if (filters?.type) {
      query = query.eq("movement_type", filters.type);
    }

    if (filters?.startDate) {
      query = query.gte("created_at", filters.startDate.toISOString());
    }

    if (filters?.endDate) {
      query = query.lte("created_at", filters.endDate.toISOString());
    }

    const { data, error } = await query;

    if (error) {
      console.error("Error fetching account movements:", error);
      throw error;
    }

    return data as AccountMovement[];
  },

  /**
   * Validate alias/cbu/cvu before transfer
   */
  async validateIdentifier(identifier: string): Promise<{
    valid: boolean;
    holder?: string;
    accountId?: string;
    isExternal?: boolean;
  } | null> {
    const cleanIdentifier = identifier.trim();

    const { data, error } = await supabase.rpc("search_account_for_transfer", {
      p_identifier: cleanIdentifier,
    } as any);

    if (error) {
      console.error("Error validating identifier:", error);
      return null;
    }

    const accounts = data as unknown as SearchAccountResult[];

    if (accounts && accounts.length > 0) {
      const result = accounts[0];

      return {
        valid: true,
        holder: result.holder_name,
        accountId: result.account_id || undefined,
        isExternal: result.is_external,
      };
    }

    return null;
  },

  /**
   * Process transfer using RPC
   */
  async transferFunds(
    fromAccountId: string,
    toIdentifier: string,
    amount: number,
    concept: string = "",
    paymentMethod: "alias" | "cbu" | "cvu" = "alias",
  ): Promise<any> {
    // Solo desde un dispositivo de confianza (lo valida el servidor con el secreto del dispositivo)
    const { data, error } = await supabase.rpc("transfer_from_device", {
      p_from_account_id: fromAccountId,
      p_to_identifier: toIdentifier,
      p_amount: amount,
      p_concept: concept,
      p_payment_method: paymentMethod,
      p_device: await getDeviceDescriptor(),
    } as any);

    if (error) {
      console.error("Error processing transfer:", error);
      // Mensajes legibles para los errores de cuentas no habilitadas (pendientes de aprobación, bloqueadas)
      if (error.message?.includes("DEVICE_NOT_TRUSTED")) {
        throw new Error("Este dispositivo no está verificado. Cierra sesión y vuelve a ingresar para verificarlo.");
      }
      if (error.message?.includes("DESTINATION_NOT_ACTIVE")) {
        throw new Error("La cuenta destino no está habilitada para recibir transferencias.");
      }
      if (error.message?.includes("AMOUNT_TOO_LOW_FOR_FEE")) {
        throw new Error("El monto no alcanza para cubrir la comisión de la transferencia.");
      }
      if (error.message?.includes("INSUFFICIENT_BALANCE")) {
        throw new Error("Saldo insuficiente para cubrir el monto y la comisión.");
      }
      if (error.message?.includes("ACCOUNT_NOT_ACTIVE")) {
        throw new Error("Tu cuenta no está habilitada para operar en este momento. Contacta a soporte si el problema persiste.");
      }
      throw error;
    }

    return data; // Returns ProcessTransferResult
  },

  /**
   * Get statistics for a period
   */
  async getStatistics(
    accountId: string,
    startDate: Date,
    endDate: Date,
    currentBalance: number = 0,
  ) {
    // Fetch movements
    const movements = await this.getAccountMovements(accountId, 2000, 0, {
      startDate,
      endDate,
    });

    // 1. Summary
    let totalIncome = 0;
    let totalExpense = 0;

    movements.forEach((m) => {
      if (m.movement_type === "income") {
        totalIncome += m.amount;
      } else if (m.movement_type === "expense") {
        totalExpense += m.amount;
      }
    });

    const incomeVsExpense =
      totalIncome > 0 ? ((totalIncome - totalExpense) / totalIncome) * 100 : 0;

    // 2. Daily Balances
    const dailyMap = new Map<string, number>();

    // Helper to get YYYY-MM-DD locally to avoid timezone shifts affecting the "day" bucket
    // Actually, safer to just use the date object's day/month/year methods to build string
    const getKey = (date: Date) => {
      return date.toISOString().split("T")[0]; // Use UTC date part for consistency with DB if needed
    };

    // Initialize days
    for (
      let d = new Date(startDate);
      d <= endDate;
      d.setDate(d.getDate() + 1)
    ) {
      dailyMap.set(getKey(d), 0);
    }

    movements.forEach((m) => {
      // Ensure we handle timestamp correctly
      const dateKey = getKey(new Date(m.created_at));
      if (dailyMap.has(dateKey)) {
        const current = dailyMap.get(dateKey) || 0;
        const val = m.movement_type === "income" ? m.amount : -m.amount;
        dailyMap.set(dateKey, current + val);
      }
    });

    const sortedDates = Array.from(dailyMap.keys()).sort(); // ISO strings sort correctly alphabetically

    const chartDataPoints: { label: string; value: number; meta: any }[] = [];
    let runningBalance = currentBalance;

    for (let i = sortedDates.length - 1; i >= 0; i--) {
      const dateStr = sortedDates[i];
      const netChange = dailyMap.get(dateStr) || 0;
      const date = new Date(dateStr);
      // Fix: 'date' from YYYY-MM-DD string might generally be parsed as UTC.
      // We want to display day/month.
      // getUTCDate() avoids timezone shift issues when parsing "2024-01-31" which refers to UTC midnight.
      const day = date.getUTCDate();
      const month = date.toLocaleString("es-ES", {
        month: "short",
        timeZone: "UTC",
      });

      chartDataPoints.unshift({
        label: `${day}/${date.getUTCMonth() + 1}`,
        value: runningBalance,
        meta: { date: dateStr },
      });

      runningBalance = runningBalance - netChange;
    }

    return {
      summary: {
        income: totalIncome,
        expense: totalExpense,
        percentage: incomeVsExpense,
      },
      chartData: chartDataPoints,
    };
  },
};
