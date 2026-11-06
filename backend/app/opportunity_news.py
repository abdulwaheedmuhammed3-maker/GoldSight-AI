"""Curated technology, web-development and remote-career RSS feeds."""
from __future__ import annotations
from datetime import datetime, timezone
from email.utils import parsedate_to_datetime
import re, time, urllib.error, urllib.request, xml.etree.ElementTree as ET
from urllib.parse import quote, urlparse
from concurrent.futures import ThreadPoolExecutor
from threading import Lock
import asyncio

FEEDS = (
 ("TechCrunch","https://techcrunch.com/feed/","TECH"),
 ("The Verge","https://www.theverge.com/rss/index.xml","TECH"),
 ("Ars Technica","https://feeds.arstechnica.com/arstechnica/index","TECH"),
 ("Wired","https://www.wired.com/feed/rss","TECH"),
 ("Engadget","https://www.engadget.com/rss.xml","TECH"),
 ("MIT Technology Review","https://www.technologyreview.com/feed/","TECH"),
 ("Google Developers Blog","https://developers.googleblog.com/feeds/posts/default?alt=rss","WEB"),
 ("OpenAI News","https://openai.com/news/rss.xml","AI"),
 ("Google DeepMind","https://deepmind.google/blog/rss.xml","AI"),
 ("Google AI","https://blog.google/technology/ai/rss/","AI"),
 ("Hugging Face Blog","https://huggingface.co/blog/feed.xml","AI"),
 ("arXiv cs.AI","https://rss.arxiv.org/rss/cs.AI","AI"),
 ("TechCrunch AI","https://techcrunch.com/category/artificial-intelligence/feed/","AI"),
 ("TechCabal","https://techcabal.com/feed/","TECH"),
 ("Techpoint Africa","https://techpoint.africa/feed/","TECH"),
 ("Hacker News","https://hnrss.org/frontpage","WEB"),
 ("GitHub Blog","https://github.blog/feed/","WEB"),
 ("Stack Overflow Blog","https://stackoverflow.blog/feed/","WEB"),
 ("DEV Community","https://dev.to/feed","WEB"),
 ("Remote OK","https://remoteok.com/remote-jobs.rss","JOBS"),
 ("We Work Remotely · Programming","https://weworkremotely.com/categories/remote-programming-jobs.rss","JOBS"),
 ("We Work Remotely · Design","https://weworkremotely.com/categories/remote-design-jobs.rss","JOBS"),
 ("Remotive","https://remotive.com/remote-jobs/feed","JOBS"),
 ("Jobicy","https://jobicy.com/?feed=job_feed","JOBS"),
 ("Himalayas","https://himalayas.app/jobs/rss","JOBS"),
 ("RemoteFirstJobs · Python","https://remotefirstjobs.com/rss/jobs/python.rss","JOBS"),
 ("We Work Remotely · All Jobs","https://weworkremotely.com/remote-jobs.rss","JOBS"),
)
CACHE_SECONDS=60
MONITOR_INTERVAL_SECONDS=60
_monitor_task=None
_monitor_stop=None
_seen_urls=set()
_cache={"fetched_at":0.0,"items":[],"feeds":[]}
_cache_lock=Lock()

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
 # RSS/Atom feeds expose article media through several common namespaces.
 for child in node.iter():
  tag=child.tag.rsplit("}",1)[-1].lower()
  candidate=child.attrib.get("url") or child.attrib.get("href") or child.attrib.get("src")
  kind=child.attrib.get("type","").lower()
  medium=child.attrib.get("medium","").lower()
  if candidate and candidate.startswith("https://"):
   if tag in {"thumbnail","image"} or medium=="image" or kind.startswith("image/"):
    return candidate
   if tag in {"content","enclosure"} and re.search(r"\.(jpg|jpeg|png|webp|gif)(?:[?#]|$)",candidate,re.I):
    return candidate
 # Some publishers put the lead image only inside encoded HTML content.
 for child in node.iter():
  raw=child.text or ""
  if not raw: continue
  match=re.search(r'<img[^>]+(?:src|data-src)=["\'](https://[^"\']+)["\']',raw,re.I)
  if match: return match.group(1)
  match=re.search(r'<meta[^>]+property=["\']og:image["\'][^>]+content=["\'](https://[^"\']+)["\']',raw,re.I)
  if match: return match.group(1)
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

async def start_news_monitor():
 global _monitor_task, _monitor_stop
 if _monitor_task and not _monitor_task.done(): return
 _monitor_stop=asyncio.Event()
 async def monitor():
  # RSS publishers do not provide push APIs; poll sources in background and
  # publish newly detected items immediately after each completed scan.
  while not _monitor_stop.is_set():
   try:
    snapshot=await asyncio.to_thread(get_opportunity_news,150,True)
    global _seen_urls
    _seen_urls.update(item.get("url","") for item in snapshot.get("items",[]))
   except Exception:
    import logging
    logging.getLogger(__name__).exception("Background opportunity-news scan failed")
   try: await asyncio.wait_for(_monitor_stop.wait(),timeout=MONITOR_INTERVAL_SECONDS)
   except asyncio.TimeoutError: pass
 _monitor_task=asyncio.create_task(monitor())

async def stop_news_monitor():
 global _monitor_task
 if _monitor_stop: _monitor_stop.set()
 if _monitor_task:
  try: await asyncio.wait_for(_monitor_task,timeout=5)
  except asyncio.TimeoutError: _monitor_task.cancel()
  _monitor_task=None

def get_opportunity_news(limit=60,force_refresh=False):
 observed_fetched_at=float(_cache["fetched_at"])
 with _cache_lock:
  cached_at=float(_cache["fetched_at"])
  use_cache=(cached_at>0 and time.time()-cached_at<CACHE_SECONDS) if not force_refresh else cached_at>observed_fetched_at
  if use_cache:
   items,feeds=list(_cache["items"]),list(_cache["feeds"])
  else:
   # Parallel fetching keeps the full source refresh practical within one minute.
   with ThreadPoolExecutor(max_workers=min(8,len(FEEDS))) as pool:
    results=list(pool.map(lambda feed:_fetch(*feed),FEEDS))
   items=[]; feeds=[]
   for found,status in results:
    items.extend(found); feeds.append(status)
   items=list({item["url"].split("#",1)[0].rstrip("/"):item for item in items}.values())
   # Notification delivery is deduplicated and respects the device opt-in.
   try:
    from app.push_notifications import send_opportunity_notification
    for item in items:
     send_opportunity_notification(item)
   except Exception:
    import logging
    logging.getLogger(__name__).exception("Tech & Careers notification processing failed.")
   items.sort(key=lambda item:item.get("published_at") or "",reverse=True)
   _cache.update({"fetched_at":time.time(),"items":items,"feeds":feeds})
 fetched_at=float(_cache["fetched_at"])
 return {"status":"LIVE" if items else "OFFLINE","updated_at":datetime.fromtimestamp(fetched_at,timezone.utc).isoformat() if fetched_at else None,"cache_seconds":CACHE_SECONDS,"count":min(len(items),limit),"items":items[:limit],"feeds":feeds,"note":"Publisher-linked technology, developer and remote-job headlines. Confirm eligibility, pay and legitimacy on the employer's official page."}
