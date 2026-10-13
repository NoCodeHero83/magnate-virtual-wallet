/**
 * Transferencia elegida en la pantalla Transferir, pendiente de confirmar.
 *
 * Se guarda en memoria en lugar de pasarla por los parámetros de la ruta: así un
 * link externo (magnate://payment/confirm?...) no puede abrir la confirmación con un
 * destino, un monto o un nombre de destinatario armados por otro.
 */
export interface PendingTransfer {
  /** Alias, CVU o CBU tal como lo validó el servidor */
  identifier: string;
  /** Monto con el formato del input (ej. "1.500,50") */
  amount: string;
  concept: string;
  /** Titular que devolvió el servidor al buscar el destino */
  recipientName: string;
  isExternal: boolean;
}

let pending: PendingTransfer | null = null;

export const setPendingTransfer = (transfer: PendingTransfer) => {
  pending = transfer;
};

export const getPendingTransfer = (): PendingTransfer | null => pending;

export const clearPendingTransfer = () => {
  pending = null;
};
