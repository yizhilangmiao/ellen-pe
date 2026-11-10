import zipfile, shutil, os, sys
BASE = r'E:\ailian\艾莲手机版\创作版\_build\艾莲-0.1.23-免激活-dev-unsigned.apk'
DEX  = r'E:\ailian\_tmp\classes-patched.dex'
DST  = r'E:\ailian\_tmp\full-dex.apk'
zin = zipfile.ZipFile(BASE); zout = zipfile.ZipFile(DST,'w',zipfile.ZIP_DEFLATED)
n=0; total=0; old=None
try:
    for zi in zin.infolist():
        total+=1
        ni = zipfile.ZipInfo(zi.filename, date_time=zi.date_time)
        ni.compress_type = zi.compress_type; ni.external_attr = zi.external_attr; ni.create_system = zi.create_system
        if zi.filename=='classes.dex':
            with open(DEX,'rb') as f, zout.open(ni,'w') as w: shutil.copyfileobj(f,w)
            n+=1; continue
        if zi.is_dir(): zout.writestr(ni,b''); continue
        with zin.open(zi,'r') as r, zout.open(ni,'w') as w: shutil.copyfileobj(r,w,1<<20)
finally:
    zin.close(); zout.close()
print('entries',total,'dex replaced',n,'->',DST, os.path.getsize(DST))
