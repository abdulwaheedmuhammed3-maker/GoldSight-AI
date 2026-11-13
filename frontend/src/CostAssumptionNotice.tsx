/**
 * Makes omitted transaction costs explicit in historical research screens.
 * User-entered values are estimates, not broker-calibrated historical fills.
 */
export default function CostAssumptionNotice({ commission, slippage }: {
  commission: string
  slippage: string
}) {
  const commissionIsZero = Number(commission) === 0
  const slippageIsZero = Number(slippage) === 0
  const incomplete = commissionIsZero || slippageIsZero

  return (
    <div className={`backtest-cost-notice ${incomplete ? 'is-warning' : 'is-estimate'}`} role="note">
      <strong>{incomplete ? 'Execution costs are incomplete' : 'Estimated execution costs applied'}</strong>
      <span>
        {incomplete
          ? `Commission: ${commissionIsZero ? '0 (excluded)' : commission + ' R'} · Slippage/side: ${slippageIsZero ? '0 (excluded)' : slippage}. Enter your broker's specifications before relying on net results.`
          : `Commission: ${commission} R · Slippage/side: ${slippage} price units. These are estimates, not historical broker fills; verify them against your account contract specifications.`}
      </span>
    </div>
  )
}
