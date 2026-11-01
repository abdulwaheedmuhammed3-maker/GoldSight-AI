//+------------------------------------------------------------------+
//| TradeSightBridge.mq5                                             |
//| Read-only MT5 companion foundation. No order placement.          |
//+------------------------------------------------------------------+
#property strict
#property version   "1.00"
#property description "TradeSight read-only terminal/account diagnostics. Does not trade."

input bool EnableAccountSnapshot = false; // Opt-in: balance/equity are sensitive
input int RefreshSeconds = 15;

datetime last_report = 0;

string SafeText(string value)
{
   StringReplace(value, "\r", " ");
   StringReplace(value, "\n", " ");
   return value;
}

void OnInit()
{
   EventSetTimer(MathMax(5, RefreshSeconds));
   Print("TradeSight Bridge initialized in READ-ONLY mode. Order execution is not implemented.");
   ReportSnapshot();
}

void OnDeinit(const int reason)
{
   EventKillTimer();
   Comment("");
}

void OnTimer()
{
   ReportSnapshot();
}

void ReportSnapshot()
{
   const long login = AccountInfoInteger(ACCOUNT_LOGIN);
   const string server = AccountInfoString(ACCOUNT_SERVER);
   const string company = AccountInfoString(ACCOUNT_COMPANY);
   const string currency = AccountInfoString(ACCOUNT_CURRENCY);
   const long leverage = AccountInfoInteger(ACCOUNT_LEVERAGE);
   const string terminal = TerminalInfoString(TERMINAL_NAME);
   const string version = TerminalInfoString(TERMINAL_BUILD);

   string report = "TradeSight MT5 Bridge | READ ONLY\n";
   report += "Broker: " + SafeText(company) + "\n";
   report += "Server: " + SafeText(server) + "\n";
   report += "Account: " + (string)login + " | " + currency + " | 1:" + (string)leverage + "\n";
   report += "Terminal: " + SafeText(terminal) + " | Build " + version + "\n";
   report += "Connected: " + (TerminalInfoInteger(TERMINAL_CONNECTED) ? "YES" : "NO") + "\n";
   report += "Trade allowed: " + (TerminalInfoInteger(TERMINAL_TRADE_ALLOWED) ? "YES (not used)" : "NO") + "\n";
   report += "Open positions: " + (string)PositionsTotal() + "\n";
   report += "Order execution: DISABLED";

   if(EnableAccountSnapshot)
   {
      report += "\nBalance: " + DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE), 2);
      report += "\nEquity: " + DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY), 2);
      report += "\nFree margin: " + DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE), 2);
   }
   Comment(report);
   last_report = TimeCurrent();
}
//+------------------------------------------------------------------+
