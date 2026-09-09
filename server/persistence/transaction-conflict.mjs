// Prisma can expose conflicts either as P2034 or directly from its PG adapter,
// especially when serialization fails while committing a transaction.
export function isTransactionConflict(error) {
  return [error, error?.cause, error?.meta?.driverAdapterError, error?.meta?.driverAdapterError?.cause]
    .some(value => value?.code === 'P2034' || value?.code === '40001'
      || value?.originalCode === '40001' || value?.kind === 'TransactionWriteConflict')
}
