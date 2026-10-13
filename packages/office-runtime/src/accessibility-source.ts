/** Read-only Windows MSAA/IAccessible2 bridge for our own LibreOffice HWND.
 * Interface signatures follow Microsoft's oleacc.h and Linux Foundation IA2 IDL.
 * No UI names, caret positions or model text are used as a substitute for visible text.
 */
export const nativeOfficeAccessibilitySource = String.raw`
import ctypes as _AC
from ctypes import wintypes as _AW
import uuid as _AU
import re as _AR
import math as _AM

class _AGUID(_AC.Structure):
    _fields_=[('Data1',_AC.c_ulong),('Data2',_AC.c_ushort),('Data3',_AC.c_ushort),('Data4',_AC.c_ubyte*8)]
    def __init__(self,value):
        super().__init__();_AC.memmove(_AC.byref(self),_AU.UUID(value).bytes_le,16)
class _AUnion(_AC.Union):
    _fields_=[('lVal',_AC.c_long),('pointer',_AC.c_void_p),('llVal',_AC.c_longlong),('padding',_AC.c_byte*16)]
class _AVariant(_AC.Structure):
    _anonymous_=('value',)
    _fields_=[('vt',_AC.c_ushort),('r1',_AC.c_ushort),('r2',_AC.c_ushort),('r3',_AC.c_ushort),('value',_AUnion)]
_AAcc=_AC.WinDLL('oleacc');_AAuto=_AC.WinDLL('oleaut32');_ACom=_AC.WinDLL('ole32')
_AAcc.AccessibleObjectFromWindow.argtypes=[_AW.HWND,_AW.DWORD,_AC.POINTER(_AGUID),_AC.POINTER(_AC.c_void_p)];_AAcc.AccessibleObjectFromWindow.restype=_AC.c_long
_AAcc.AccessibleChildren.argtypes=[_AC.c_void_p,_AC.c_long,_AC.c_long,_AC.POINTER(_AVariant),_AC.POINTER(_AC.c_long)];_AAcc.AccessibleChildren.restype=_AC.c_long
_AAuto.SysFreeString.argtypes=[_AC.c_void_p];_AAuto.SysFreeString.restype=None
_AAuto.VariantClear.argtypes=[_AC.POINTER(_AVariant)];_AAuto.VariantClear.restype=_AC.c_long
_ACom.CoInitializeEx.argtypes=[_AC.c_void_p,_AW.DWORD];_ACom.CoInitializeEx.restype=_AC.c_long
_ACom.CoUninitialize.argtypes=[];_ACom.CoUninitialize.restype=None
_AIID='618736e0-3c3d-11cf-810c-00aa00389b71'
_AIA2='e89f726e-c4f4-4c19-bb19-b647d7fa8478'
_AText='24fd2ffb-3aad-4a08-8335-a3ad89c0fb4b'
_AProvider='6d5140c1-7436-11ce-8034-00aa006009fa'

def _a_call(pointer,index,*signature):
    table=_AC.cast(pointer,_AC.POINTER(_AC.POINTER(_AC.c_void_p))).contents
    return _AC.WINFUNCTYPE(_AC.c_long,_AC.c_void_p,*signature)(table[index])
def _a_release(pointer):
    if pointer:_a_call(pointer,2)(pointer)
def _a_query(pointer,iid):
    out=_AC.c_void_p();hr=_a_call(pointer,0,_AC.POINTER(_AGUID),_AC.POINTER(_AC.c_void_p))(pointer,_AC.byref(_AGUID(iid)),_AC.byref(out))
    return out.value if hr>=0 else None
def _a_ia2(pointer):
    provider=_a_query(pointer,_AProvider)
    if not provider:return None
    try:
        out=_AC.c_void_p();hr=_a_call(provider,3,_AC.POINTER(_AGUID),_AC.POINTER(_AGUID),_AC.POINTER(_AC.c_void_p))(provider,_AC.byref(_AGUID(_AIID)),_AC.byref(_AGUID(_AIA2)),_AC.byref(out))
        return out.value if hr>=0 else None
    finally:_a_release(provider)
def _a_text(pointer):
    direct=_a_query(pointer,_AText)
    if direct:return direct
    ia2=_a_ia2(pointer)
    if not ia2:return None
    try:return _a_query(ia2,_AText)
    finally:_a_release(ia2)
def _a_self():
    child=_AVariant();child.vt=3;child.lVal=0;return child
def _a_value(pointer,index):
    out=_AVariant();hr=_a_call(pointer,index,_AVariant,_AC.POINTER(_AVariant))(pointer,_a_self(),_AC.byref(out))
    try:return out.lVal if hr>=0 and out.vt==3 else None
    finally:_AAuto.VariantClear(_AC.byref(out))
def _a_string(pointer,index):
    out=_AC.c_void_p();hr=_a_call(pointer,index,_AVariant,_AC.POINTER(_AC.c_void_p))(pointer,_a_self(),_AC.byref(out))
    try:return _AC.wstring_at(out) if hr>=0 and out else ''
    finally:_AAuto.SysFreeString(out)
def _a_box(pointer):
    values=[_AC.c_long() for _ in range(4)];hr=_a_call(pointer,22,*([_AC.POINTER(_AC.c_long)]*4),_AVariant)(pointer,*[_AC.byref(v) for v in values],_a_self())
    return tuple(v.value for v in values) if hr>=0 else None
def _a_hit(pointer,x,y):
    out=_AVariant();hr=_a_call(pointer,24,_AC.c_long,_AC.c_long,_AC.POINTER(_AVariant))(pointer,int(x),int(y),_AC.byref(out));result=None
    try:
        if hr>=0 and out.vt==9 and out.pointer:result=_a_query(out.pointer,_AIID)
        elif hr>=0 and out.vt==3 and out.lVal>0:
            dispatch=_AC.c_void_p();hr=_a_call(pointer,9,_AVariant,_AC.POINTER(_AC.c_void_p))(pointer,out,_AC.byref(dispatch))
            if hr>=0 and dispatch:
                try:result=_a_query(dispatch.value,_AIID)
                finally:_a_release(dispatch.value)
        return result
    finally:_AAuto.VariantClear(_AC.byref(out))
def _a_visible_cells(pointer,area,deadline,limit):
    # Calc intentionally exposes no enumerable children (MANAGES_DESCENDANTS).
    # Hit-test the actual table viewport and advance using each real cell's bounds.
    result=[];seen=set();y=area[1]+1;bottom=area[1]+area[3];right=area[0]+area[2];limited=False
    while y<bottom:
        x=area[0]+1;next_y=bottom
        while x<right:
            if len(result)>=limit or time.monotonic()>deadline:return result,True
            cell=_a_hit(pointer,x,y)
            if not cell:x+=24;limited=True;continue
            box=_a_box(cell);role=_a_value(cell,13)
            if role!=29 or not box or not _a_clip(box,area):_a_release(cell);x+=24;limited=True;continue
            key=tuple(box)
            if key not in seen:seen.add(key);result.append(cell)
            else:_a_release(cell)
            x=max(x+1,box[0]+box[2]);next_y=min(next_y,max(y+1,box[1]+box[3]))
        y=max(y+1,next_y)
    return result,limited
def _a_count(pointer):
    out=_AC.c_long();hr=_a_call(pointer,8,_AC.POINTER(_AC.c_long))(pointer,_AC.byref(out));return max(0,out.value) if hr>=0 else 0
def _a_children(pointer,limit=160):
    total=_a_count(pointer);size=min(total,limit)
    if size<=0:return [],False
    values=(_AVariant*size)();count=_AC.c_long();hr=_AAcc.AccessibleChildren(pointer,0,size,values,_AC.byref(count));children=[]
    if hr>=0:
        for i in range(count.value):
            item=values[i];dispatch=None
            if item.vt==9 and item.pointer:dispatch=item.pointer
            elif item.vt==3:
                out=_AC.c_void_p();result=_a_call(pointer,9,_AVariant,_AC.POINTER(_AC.c_void_p))(pointer,item,_AC.byref(out))
                if result>=0 and out:dispatch=out.value
            if dispatch:
                child=_a_query(dispatch,_AIID)
                if child:children.append(child)
                if item.vt!=9:_a_release(dispatch)
            _AAuto.VariantClear(_AC.byref(values[i]))
    return children,total>size
def _a_clip(box,viewport):
    if not box or box[2]<=0 or box[3]<=0:return None
    x=max(box[0],viewport[0]);y=max(box[1],viewport[1]);r=min(box[0]+box[2],viewport[0]+viewport[2]);b=min(box[1]+box[3],viewport[1]+viewport[3])
    return (x,y,r-x,b-y) if r>x and b>y else None
def _a_coordinate_scale(view):
    # The host validates this against its real client pixels and renderer viewport.
    # Windows DPI alone does not account for Electron's scale/zoom configuration.
    value=view.get('coordinateScale')
    return float(value) if isinstance(value,(int,float)) and not isinstance(value,bool) and _AM.isfinite(value) and value>0 else None
def _a_css_rect(box,origin,scale):
    return {'x':(box[0]-origin[0])/scale,'y':(box[1]-origin[1])/scale,'width':box[2]/scale,'height':box[3]/scale}
def _a_character(text,index):
    out=[_AC.c_long() for _ in range(4)];hr=_a_call(text,6,_AC.c_long,_AC.c_int,*([_AC.POINTER(_AC.c_long)]*4))(text,index,0,*[_AC.byref(v) for v in out])
    return tuple(v.value for v in out) if hr>=0 else None
def _a_visible_offsets(text,length,area,deadline):
    if length<=512:return range(length),False
    hits=[];x_points=[area[0]+area[2]*fraction for fraction in (.12,.3,.5,.7,.9)];y=area[1]+1
    while y<area[1]+area[3]:
        for x in x_points:
            if time.monotonic()>deadline:return range(0,min(length,6000)),True
            index=_AC.c_long(-1);hr=_a_call(text,8,_AC.c_long,_AC.c_long,_AC.c_int,_AC.POINTER(_AC.c_long))(text,int(x),int(y),0,_AC.byref(index))
            if hr>=0 and index.value>=0:hits.append(index.value)
        y+=18
    if hits:
        start=max(0,min(hits)-256);end=min(length,max(hits)+257)
        return range(start,min(end,start+6000)),end-start>6000
    return range(min(length,6000)),length>6000
def _a_cell_in_selection(area,name):
    if area is None:return False
    match=_AR.fullmatch(r'([A-Z]+)([1-9][0-9]*)',name)
    if not match:return False
    column=0
    for letter in match.group(1):column=column*26+ord(letter)-64
    try:
        row=int(match.group(2))-1
        return area.StartColumn<=column-1<=area.EndColumn and area.StartRow<=row<=area.EndRow
    except:return False
def _a_text_value(text,max_chars=48000):
    count=_AC.c_long();hr=_a_call(text,17,_AC.POINTER(_AC.c_long))(text,_AC.byref(count))
    if hr<0 or count.value<0:return '',0,False
    length=min(count.value,max_chars);out=_AC.c_void_p();hr=_a_call(text,10,_AC.c_long,_AC.c_long,_AC.POINTER(_AC.c_void_p))(text,0,length,_AC.byref(out))
    try:return (_AC.wstring_at(out) if hr>=0 and out else ''),length,count.value>length
    finally:_AAuto.SysFreeString(out)
def _a_selections(text):
    count=_AC.c_long();hr=_a_call(text,7,_AC.POINTER(_AC.c_long))(text,_AC.byref(count));ranges=[]
    if hr>=0:
        for i in range(min(16,max(0,count.value))):
            start=_AC.c_long();end=_AC.c_long();hr=_a_call(text,9,_AC.c_long,_AC.POINTER(_AC.c_long),_AC.POINTER(_AC.c_long))(text,i,_AC.byref(start),_AC.byref(end))
            if hr>=0 and end.value>start.value>=0:ranges.append((start.value,end.value))
    return ranges

def native_accessibility(view):
    """(visibleText, truncated, pendingInput, selectionRect CSS/DIP, ready).
    Uses only the frame's owned HWND, document subtrees and actual painted bounds.
    Traversal limits are explicit; unavailable trees never become successful text.
    """
    empty=('',False,False,None,False);hwnd=view.get('hwnd');view['accessibilityViewportSignature']=None;density=_a_coordinate_scale(view)
    if density is None:return empty
    if not hwnd or view.get('disposed') or not view.get('visible') or not user32.IsWindowVisible(hwnd):return empty
    try:
        if int(view['frame'].getContainerWindow().getWindowHandle((),SYSTEM_WIN32))!=int(hwnd):return empty
        client=rectangle(hwnd,True);origin=_AW.POINT();user32.ClientToScreen(hwnd,_AC.byref(origin));viewport=(origin.x,origin.y,client['width'],client['height'])
    except:return empty
    cell_selection=None
    if view.get('format')=='xlsx':
        try:cell_selection=view['controller'].getSelection().getRangeAddress()
        except:pass
    initialized=_ACom.CoInitializeEx(None,0)>=0;root=_AC.c_void_p();queue_nodes=[];pieces=[];selected=[];truncated=False;pending=False;ready=False;visited=0;signature=[];deadline=time.monotonic()+.18
    try:
        hr=_AAcc.AccessibleObjectFromWindow(hwnd,0xfffffffc,_AC.byref(_AGUID(_AIID)),_AC.byref(root))
        if hr<0 or not root:return empty
        queue_nodes=[(root.value,False,0,viewport)];root=None
        while queue_nodes:
            pointer,in_document,depth,scope=queue_nodes.pop(0)
            try:
                if visited>=600 or time.monotonic()>deadline:truncated=True;break
                visited+=1;role=_a_value(pointer,13);states=_a_value(pointer,14) or 0
                # Menu, toolbar, scrollbar, separator, list/header UI do not belong to source text.
                if role in (2,3,12,21,22,25,26) or states&0x8000:continue
                box=_a_box(pointer);clipped=_a_clip(box,scope)
                if not clipped:continue
                in_document=in_document or role==15
                if role==15:ready=True;scope=clipped
                text=_a_text(pointer) if in_document else None;has_own_text=False
                if text:
                    try:
                        content,length,limited=_a_text_value(text);truncated=truncated or limited;has_own_text=bool(content) and '\ufffc' not in content
                        if content and len(signature)<20:signature.append((role,tuple(round(v/density,3) for v in (clipped[0]-origin.x,clipped[1]-origin.y,clipped[2],clipped[3])),content[:32]))
                        units=content.encode('utf-16-le',errors='surrogatepass');ranges=_a_selections(text)
                        # MSAA can clip a paragraph/cell box while its text still includes offscreen
                        # lines or a frozen pane's hidden portion. Check actual end glyphs too.
                        first=_a_character(text,0) if length else None;last=_a_character(text,length-1) if length else None
                        whole=box==clipped and first is not None and last is not None and _a_clip(first,scope)==first and _a_clip(last,scope)==last
                        if whole and content:pieces.append((clipped[1],clipped[0],content))
                        elif content:
                            shown=[]
                            indices,limited=_a_visible_offsets(text,length,clipped,deadline);truncated=truncated or limited
                            for index in indices:
                                if time.monotonic()>deadline:truncated=True;break
                                if _a_clip(_a_character(text,index),scope):shown.append(units[index*2:index*2+2])
                            if shown:pieces.append((clipped[1],clipped[0],b''.join(shown).decode('utf-16-le',errors='replace')))
                        for start,end in ranges:
                            for index in range(start,min(end,start+2000)):
                                if time.monotonic()>deadline:truncated=True;break
                                character=_a_clip(_a_character(text,index),scope)
                                if character:selected.append(character)
                            if end-start>2000:truncated=True
                    finally:_a_release(text)
                if in_document and ((role in (29,40) and states&2) or (role==29 and _a_cell_in_selection(cell_selection,_a_string(pointer,10)))):selected.append(clipped)
                # Calc's actual focused editor is TEXT, not a selected cell/Writer paragraph.
                if view.get('format')=='xlsx' and in_document and role==42 and states&4:pending=True
                if depth<14 and not has_own_text:
                    if in_document and role==24 and view.get('format')=='xlsx':children,limited=_a_visible_cells(pointer,clipped,deadline,min(200,600-visited))
                    else:children,limited=_a_children(pointer,min(200,600-visited))
                    truncated=truncated or limited
                    entries=[(child,in_document,depth+1,scope) for child in children]
                    if in_document:queue_nodes[0:0]=entries
                    else:queue_nodes.extend(entries)
            except:truncated=True
            finally:_a_release(pointer)
        text='\n'.join(v[2] for v in sorted(pieces,key=lambda v:(v[0],v[1])));rect=None
        if selected:
            x=min(v[0] for v in selected);y=min(v[1] for v in selected);r=max(v[0]+v[2] for v in selected);b=max(v[1]+v[3] for v in selected)
            rect=_a_css_rect((x,y,r-x,b-y),(origin.x,origin.y),density)
        if ready:view['accessibilityViewportSignature']=hashlib.sha256(json.dumps(signature,ensure_ascii=False,separators=(',',':')).encode('utf-8')).hexdigest()
        return text[:12000],truncated or len(text)>12000,pending,rect,ready
    except:return empty
    finally:
        if root:_a_release(root.value)
        for pointer,_,_,_ in queue_nodes:_a_release(pointer)
        if initialized:_ACom.CoUninitialize()
`;
