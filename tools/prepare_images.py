"""Run from the project root:  python tools/prepare_images.py
Downloads each drink photo (Ambrosia URL, else Google Custom Search), removes the white
background (only white connected to the border, so white labels survive) and writes public/img/<id>.png
pip install pillow numpy scipy requests ; optional env: GOOGLE_API_KEY, GOOGLE_CX"""
import io,json,os,requests,numpy as np
from PIL import Image,ImageFilter
from scipy import ndimage as ndi
UA={"User-Agent":"Mozilla/5.0"};KEY,CX=os.getenv("GOOGLE_API_KEY"),os.getenv("GOOGLE_CX")
def google_urls(name,fmt):
    if not(KEY and CX):return[]
    kind={"can":"can","wine":"wine bottle"}.get(fmt,"bottle")
    r=requests.get("https://www.googleapis.com/customsearch/v1",params=dict(key=KEY,cx=CX,q=f"{name} {kind} white background",searchType="image",imgType="photo",num=5,safe="active"),timeout=20)
    return[i["link"] for i in r.json().get("items",[])] if r.ok else[]
def cutout(im,tol=22):
    im=im.convert("RGBA");a=np.array(im)
    if(a[...,3]<250).mean()>0.05:mask=a[...,3]>10
    else:
        rgb=a[...,:3].astype(int);lab,_=ndi.label((rgb>=255-tol).all(axis=2))
        edge=set(np.unique(np.concatenate([lab[0],lab[-1],lab[:,0],lab[:,-1]])))-{0}
        mask=ndi.binary_fill_holes(ndi.binary_opening(~np.isin(lab,list(edge)),iterations=1))
        l2,n=ndi.label(mask)
        if n>1:mask=l2==(1+int(np.argmax(ndi.sum(mask,l2,range(1,n+1)))))
    im.putalpha(Image.fromarray((mask*255).astype("uint8")).filter(ImageFilter.GaussianBlur(1.1)))
    bb=im.getchannel("A").point(lambda v:255 if v>20 else 0).getbbox()
    im=im.crop(bb) if bb else im;im.thumbnail((700,900));return im
os.makedirs("public/img",exist_ok=True)
for d in json.load(open("public/drinks.json")):
    out=f"public/img/{d['id']}.png"
    if os.path.exists(out):continue
    for u in list(d.get("img",[]))+google_urls(d["name"],d["fmt"]):
        try:
            r=requests.get(u,headers=UA,timeout=20);r.raise_for_status()
            cutout(Image.open(io.BytesIO(r.content))).save(out);print("ok  ",d["name"],u);break
        except Exception as e:print("skip",d["name"],u,type(e).__name__)
    else:print("NONE",d["name"])
