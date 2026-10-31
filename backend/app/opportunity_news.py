"""Curated technology, web-development and remote-career RSS feeds."""
from __future__ import annotations
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import re, time, urllib.error, urllib.request, xml.etree.ElementTree as ET
from urllib.parse import quote, urlparse

FEEDS = (
 ("TechCrunch","https://techcrunch.com/feed/","TECH"),
 ("The Verge","https://www.theverge.com/rss/index.xml","TECH"),
 ("Hacker News","https://hnrss.org/frontpage","WEB"),
 ("GitHub Blog","https://github.blog/feed/","WEB"),
 ("Stack Overflow Blog","https://stackoverflow.blog/feed/","WEB"),
 ("Remote OK","https://remoteok.com/remote-jobs.rss","JOBS"),
 ("We Work Remotely · Programming","https://weworkremotely.com/categories/remote-programming-jobs.rss","JOBS"),
 ("We Work Remotely · Design","https://weworkremotely.com/categories/remote-design-jobs.rss","JOBS"),
)
CACHE_SECONDS=600
_cache={"fetched_at":0.0,"items":[],"feeds":[]}

def _text(node,names):
 for child in node.iter():
  if child.tag.rsplit("}",1)[-1].lower() in names and child.text: return child.text.strip()
 return ""

def _date(raw):
 if not raw: return None
 try:
  value=parsedate_to_datetime(raw)
  if value.tzinfo is None: value=value.replace(tzinfo=timezone.utc)
  return value.astimezone(timezone.utc).isoformat()
 except (TypeError,ValueError,OverflowError):
  try:
   value=datetime.fromisoformat(raw.replace("Z","+00:00"))
   if value.tzinfo is None: value=value.replace(tzinfo=timezone.utc)
   return value.astimezone(timezone.utc).isoformat()
  except (TypeError,ValueError,OverflowError): return None

def _clean(value,maximum=420):
 value=re.sub(r"<[^>]+>"," ",value)
 value=re.sub(r"\s+"," ",value).strip()
 return value[:maximum]+("…" if len(value)>maximum else "")

def _image(node):
 for child in node.iter():
  tag=child.tag.rsplit("}",1)[-1].lower()
  candidate=child.attrib.get("url") or child.attrib.get("href")
  kind=child.attrib.get("type","").lower()
  if candidate and candidate.startswith("https://") and (tag in {"thumbnail","image"} or (tag in {"content","enclosure"} and (kind.startswith("image/") or re.search(r"\.(jpg|jpeg|png|webp)(?:[?#]|$)",candidate,re.I)))): return candidate
 return None

def _eligibility(value):
 value=value.lower()
 if re.search(r"\b(nigeria|nigerian|africa|african|worldwide|anywhere|global|work from anywhere)\b",value): return "Potentially open to Nigeria"
 if re.search(r"\b(us only|united states only|must be based in the us|uk only|europe only|canada only)\b",value): return "Restricted location stated"
 return "Not confirmed · check employer policy"

def _fetch(name,url,category):
 request=urllib.request.Request(url,headers={"User-Agent":"TradeSight/1.0 (+news-feed)","Accept":"application/rss+xml, application/atom+xml, application/xml, text/xml"})
 try:
  with urllib.request.urlopen(request,timeout=7) as response: payload=response.read(1500000)
  root=ET.fromstring(payload); items=[]
  for node in root.iter():
   if node.tag.rsplit("}",1)[-1].lower() not in {"item","entry"}: continue
   title=_text(node,("title",)); link=_text(node,("link",))
   if not link:
    for child in node:
     if child.tag.rsplit("}",1)[-1].lower()=="link":
      link=child.attrib.get("href","")
      if link: break
   if not title or not link.startswith("https://"): continue
   summary=_clean(_text(node,("description","summary","encoded","content")))
   items.append({"id":name+":"+link,"title":_clean(title,240),"summary":summary,"url":link,"source":name,"image_url":_image(node),"source_image_url":"https://www.google.com/s2/favicons?domain="+quote(urlparse(link).hostname or "news")+"&sz=256","published_at":_date(_text(node,("pubdate","published","updated","date"))),"category":category,"eligibility":_eligibility(title+" "+summary) if category=="JOBS" else None,"interpretation":"Publisher-linked item. Open the original source to verify details."})
  return items,{"source":name,"status":"LIVE","count":len(items),"error":None}
 except (OSError,TimeoutError,ET.ParseError,urllib.error.URLError,ValueError) as exc: return [],{"source":name,"status":"OFFLINE","count":0,"error":str(exc)[:160]}

def get_opportunity_news(limit=60,force_refresh=False):
 now=time.time()
 if not force_refresh and now-float(_cache["fetched_at"])<CACHE_SECONDS: items,feeds=list(_cache["items"]),list(_cache["feeds"])
 else:
  items=[]; feeds=[]
  for name,url,category in FEEDS:
   found,status=_fetch(name,url,category); items.extend(found); feeds.append(status)
  items=list({item["url"].split("#",1)[0].rstrip("/"):item for item in items}.values())
  items.sort(key=lambda item:item.get("published_at") or "",reverse=True)
  _cache.update({"fetched_at":now,"items":items,"feeds":feeds})
 return {"status":"LIVE" if items else "OFFLINE","updated_at":datetime.now(timezone.utc).isoformat(),"cache_seconds":CACHE_SECONDS,"count":min(len(items),limit),"items":items[:limit],"feeds":feeds,"note":"Publisher-linked technology, developer and remote-job headlines. Confirm eligibility, pay and legitimacy on the employer's official page."}
