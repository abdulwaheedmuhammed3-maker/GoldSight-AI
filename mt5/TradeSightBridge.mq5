//+------------------------------------------------------------------+
//| TradeSightBridge.mq5                                             |
//| Read-only MT5 companion. Optional authenticated telemetry only.  |
//+------------------------------------------------------------------+
#property strict
#property version   "1.10"
#property description "TradeSight read-only terminal diagnostics and optional telemetry. Does not trade."

input bool EnableAccountSnapshot = false;
input bool EnableRemoteTelemetry = false;
input string BridgeApiUrl = "https://goldsight-ai-api.onrender.com/api/v1/mt5-bridge/heartbeat";
input string DeviceToken = "";
input int RefreshSeconds = 30;
input int MaxPositionRecords = 50;
input int ClosedHistoryDays = 30;
input int MaxClosedTradeRecords = 50;

string JsonEscape(string value)
{
   StringReplace(value, "\\", "\\\\");
   StringReplace(value, "\"", "\\\"");
   StringReplace(value, "\r", " ");
   StringReplace(value, "\n", " ");
   return value;
}


string PositionRecordsJson()
{
   string out="[";
   int limit=MathMin(PositionsTotal(),MathMax(0,MathMin(50,MaxPositionRecords)));
   bool first=true;
   for(int i=0;i<limit;i++)
   {
      ulong ticket=PositionGetTicket(i);
      if(ticket==0) continue;
      if(!first) out+=",";
      first=false;
      long type=PositionGetInteger(POSITION_TYPE);
      out+="{";
      out+="\"ticket\":\""+(string)ticket+"\",";
      out+="\"symbol\":\""+JsonEscape(PositionGetString(POSITION_SYMBOL))+"\",";
      out+="\"type\":\""+(type==POSITION_TYPE_BUY ? "BUY" : "SELL")+"\",";
      out+="\"volume\":"+DoubleToString(PositionGetDouble(POSITION_VOLUME),2)+",";
      out+="\"price_open\":"+DoubleToString(PositionGetDouble(POSITION_PRICE_OPEN),8)+",";
      out+="\"price_current\":"+DoubleToString(PositionGetDouble(POSITION_PRICE_CURRENT),8)+",";
      out+="\"stop_loss\":"+DoubleToString(PositionGetDouble(POSITION_SL),8)+",";
      out+="\"take_profit\":"+DoubleToString(PositionGetDouble(POSITION_TP),8)+",";
      out+="\"profit\":"+DoubleToString(PositionGetDouble(POSITION_PROFIT),2)+",";
      out+="\"swap\":"+DoubleToString(PositionGetDouble(POSITION_SWAP),2)+",";
      out+="\"time\":"+(string)PositionGetInteger(POSITION_TIME);
      out+="}";
   }
   return out+"]";
}

string ClosedTradeRecordsJson()
{
   string out="[";
   if(!HistorySelect(TimeCurrent()-MathMax(1,ClosedHistoryDays)*86400,TimeCurrent())) return out+"]";
   int limit=MathMax(0,MathMin(50,MaxClosedTradeRecords));
   int added=0;
   for(int i=HistoryDealsTotal()-1;i>=0 && added<limit;i--)
   {
      ulong ticket=HistoryDealGetTicket(i);
      if(ticket==0) continue;
      long entry=HistoryDealGetInteger(ticket,DEAL_ENTRY);
      if(entry!=DEAL_ENTRY_OUT && entry!=DEAL_ENTRY_OUT_BY && entry!=DEAL_ENTRY_INOUT) continue;
      if(added>0) out+=",";
      out+="{";
      out+="\"ticket\":\""+(string)ticket+"\",";
      out+="\"symbol\":\""+JsonEscape(HistoryDealGetString(ticket,DEAL_SYMBOL))+"\",";
      long type=HistoryDealGetInteger(ticket,DEAL_TYPE);
      out+="\"type\":\""+(type==DEAL_TYPE_BUY ? "BUY" : (type==DEAL_TYPE_SELL ? "SELL" : "OTHER"))+"\",";
      out+="\"volume\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_VOLUME),2)+",";
      out+="\"price\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_PRICE),8)+",";
      out+="\"profit\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_PROFIT),2)+",";
      out+="\"swap\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_SWAP),2)+",";
      out+="\"commission\":"+DoubleToString(HistoryDealGetDouble(ticket,DEAL_COMMISSION),2)+",";
      out+="\"time\":"+(string)HistoryDealGetInteger(ticket,DEAL_TIME);
      out+="}";
      added++;
   }
   return out+"]";
}

void OnInit()
{
   EventSetTimer(MathMax(10, RefreshSeconds));
   Print("TradeSight Bridge initialized in READ-ONLY mode. Order execution is not implemented.");
   ReportSnapshot();
}
void OnDeinit(const int reason) { EventKillTimer(); Comment(""); }
void OnTimer() { ReportSnapshot(); }

void ReportSnapshot()
{
   long login=AccountInfoInteger(ACCOUNT_LOGIN);
   string server=AccountInfoString(ACCOUNT_SERVER);
   string company=AccountInfoString(ACCOUNT_COMPANY);
   string currency=AccountInfoString(ACCOUNT_CURRENCY);
   long leverage=AccountInfoInteger(ACCOUNT_LEVERAGE);
   string terminal=TerminalInfoString(TERMINAL_NAME);
   string version=TerminalInfoString(TERMINAL_BUILD);
   bool connected=(bool)TerminalInfoInteger(TERMINAL_CONNECTED);

   string report="TradeSight MT5 Bridge | READ ONLY\n";
   report+="Broker: "+company+"\nServer: "+server+"\n";
   report+="Account: "+(string)login+" | "+currency+" | 1:"+(string)leverage+"\n";
   report+="Terminal: "+terminal+" | Build "+version+"\n";
   report+="Connected: "+(connected ? "YES" : "NO")+"\n";
   report+="Open positions: "+(string)PositionsTotal()+"\n";
   report+="Remote telemetry: "+(EnableRemoteTelemetry ? "ENABLED" : "DISABLED")+"\n";
   report+="Order execution: DISABLED";
   if(EnableAccountSnapshot)
   {
      report+="\nBalance: "+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2);
      report+="\nEquity: "+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2);
      report+="\nFree margin: "+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2);
   }
   Comment(report);
   if(EnableRemoteTelemetry && connected)
      SendHeartbeat(login,server,company,currency,leverage,terminal,version,connected);
}

void SendHeartbeat(long login,string server,string company,string currency,long leverage,
                   string terminal,string version,bool connected)
{
   if(StringLen(DeviceToken)<40 || StringLen(BridgeApiUrl)<12)
   { Print("TradeSight Bridge: remote telemetry enabled but URL/token is missing."); return; }

   string body="{";
   body+="\"broker\":\""+JsonEscape(company)+"\",";
   body+="\"server\":\""+JsonEscape(server)+"\",";
   body+="\"account_login\":\""+(string)login+"\",";
   body+="\"account_currency\":\""+JsonEscape(currency)+"\",";
   body+="\"leverage\":"+(string)leverage+",";
   body+="\"terminal\":\""+JsonEscape(terminal)+"\",";
   body+="\"terminal_build\":\""+JsonEscape(version)+"\",";
   body+="\"connected\":"+(connected ? "true" : "false")+",";
   body+="\"open_positions\":"+(string)PositionsTotal()+",";
   body+="\"position_items\":"+PositionRecordsJson()+",";
   body+="\"recent_closed_trades\":"+ClosedTradeRecordsJson();
   if(EnableAccountSnapshot)
   {
      body+=",\"balance\":"+DoubleToString(AccountInfoDouble(ACCOUNT_BALANCE),2);
      body+=",\"equity\":"+DoubleToString(AccountInfoDouble(ACCOUNT_EQUITY),2);
      body+=",\"free_margin\":"+DoubleToString(AccountInfoDouble(ACCOUNT_MARGIN_FREE),2);
   }
   body+="}";

   char data[],response[];
   string response_headers;
   int bytes=StringToCharArray(body,data,0,WHOLE_ARRAY,CP_UTF8);
   if(bytes>0) ArrayResize(data,bytes-1);
   string headers="Content-Type: application/json\r\nAuthorization: Bearer "+DeviceToken+"\r\n";
   ResetLastError();
   int status=WebRequest("POST",BridgeApiUrl,headers,8000,data,response,response_headers);
   if(status==200) Print("TradeSight Bridge: read-only telemetry accepted.");
   else Print("TradeSight Bridge: telemetry failed. HTTP=",status," error=",GetLastError(),
              ". Check MT5 WebRequest URL allow-list and connection.");
}
//+------------------------------------------------------------------+
