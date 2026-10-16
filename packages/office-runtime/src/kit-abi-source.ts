/** C ABI pinned to the bundled LibreOffice 26.8.1.1 public LibreOfficeKit.h.
 * Every call is gated by the table's nSize. freeError is static (no pThis).
 * Upstream: https://github.com/LibreOffice/core/blob/libreoffice-26.8.1.1/include/LibreOfficeKit/LibreOfficeKit.h
 */
export const officeKitAbiSource = String.raw`
P=C.c_void_p; I=C.c_int; U=C.c_uint; B=C.c_bool; S=C.c_char_p; Z=C.c_size_t; L=C.c_long
OFFICE_FIELDS='destroy documentLoad getError documentLoadWithOptions freeError registerCallback getFilterTypes setOptionalFeatures setDocumentPassword getVersionInfo runMacro signDocument runLoop setOption dumpState extractRequest trimMemory startURP stopURP joinThreads startThreads setForkedChild extractDocumentStructureRequest registerAnyInputCallback getDocsCount registerFileSaveDialogCallback'.split()
DOCUMENT_FIELDS='destroy saveAs getDocumentType getParts getPartPageRectangles getPart setPart getPartName setPartMode paintTile getTileMode getDocumentSize initializeForRendering registerCallback postKeyEvent postMouseEvent postUnoCommand setTextSelection getTextSelection paste setGraphicSelection resetSelection getCommandValues setClientZoom setClientVisibleArea createView destroyView setView getView getViewsCount renderFont getPartHash paintPartTile getViewIds setOutlineState paintWindow postWindow postWindowKeyEvent postWindowMouseEvent setViewLanguage postWindowExtTextInputEvent getPartInfo paintWindowDPI insertCertificate addCertificate getSignatureState renderShapeSelection postWindowGestureEvent createViewWithOptions selectPart moveSelectedParts resizeWindow getClipboard setClipboard getSelectionType removeTextContext renderFontOrientation paintWindowForView completeFunction setWindowTextSelection sendFormFieldEvent setBlockedCommandList renderSearchResult sendContentControlEvent getSelectionTypeAndText getDataArea getEditMode setViewTimezone setAccessibilityState getA11yFocusedParagraph getA11yCaretPosition setViewReadOnly getPresentationInfo createSlideRenderer postSlideshowCleanup renderNextSlideLayer setViewOption setColorPreviewState'.split()
class OfficeTable(C.Structure):_fields_=[('nSize',Z)]+[(name,P) for name in OFFICE_FIELDS]
class DocumentTable(C.Structure):_fields_=[('nSize',Z)]+[(name,P) for name in DOCUMENT_FIELDS]
CALLBACK=C.CFUNCTYPE(None,I,S,P)
def abi_table(instance,definition):return C.cast(C.cast(instance,C.POINTER(P))[0],C.POINTER(definition)).contents
def abi_has(instance,definition,name):
    values=abi_table(instance,definition)
    return getattr(definition,name).offset+C.sizeof(P)<=values.nSize and bool(getattr(values,name))
def abi_call(instance,definition,name,result,*types):
    if not abi_has(instance,definition,name):fail('OFFICE_KIT_ABI_UNAVAILABLE','当前 Office 引擎不支持所需接口：'+name)
    function=C.CFUNCTYPE(result,P,*types)(getattr(abi_table(instance,definition),name))
    return lambda *args:function(instance,*args)
def office_call(name,result,*types):return abi_call(office,OfficeTable,name,result,*types)
def doc_call(session,name,result,*types):return abi_call(session['kit'],DocumentTable,name,result,*types)

# Public Windows x64 static VCL functions in the same hash/version-pinned DLL.
# svapp.hxx: Reschedule(bool)->bool handles only current events and does not
# sleep; unlike ProcessEventsToIdle, one invocation cannot busy-lock itself.
vcl_reschedule=getattr(dll,'?Reschedule@Application@@SA_N_N@Z');vcl_reschedule.argtypes=[B];vcl_reschedule.restype=B
vcl_main_thread=getattr(dll,'?IsMainThread@Application@@SA_NXZ');vcl_main_thread.argtypes=[];vcl_main_thread.restype=B
vcl_system_loop=getattr(dll,'?IsUseSystemEventLoop@Application@@SA_NXZ');vcl_system_loop.argtypes=[];vcl_system_loop.restype=B

# Exact LOK window -> UNO top-window binding. The existing adapter has already
# checked the complete mergedlo.dll SHA-256. FindLOKWindow returns VclPtr<Window>
# into caller storage on Windows x64. Its acquire uses Window's vbptr at +8 and
# vbtable displacement at +4 (pinned RVA 0x2dae65d); balance that same reference
# through the vendor's release, never retain an extra native dialog reference.
vcl_find_window=getattr(dll,'?FindLOKWindow@Window@vcl@@SA?AV?$VclPtr@VWindow@vcl@@@@K@Z');vcl_find_window.argtypes=[P,U];vcl_find_window.restype=P
vcl_window_system=getattr(dll,'?GetSystemData@Window@vcl@@UEBAPEBUSystemEnvData@@XZ');vcl_window_system.argtypes=[P];vcl_window_system.restype=P
vcl_release=getattr(dll,'?release@VclReferenceBase@@QEBAXXZ');vcl_release.argtypes=[P];vcl_release.restype=None

def kit_window_handle(identifier):
    holder=P();vcl_find_window(C.byref(holder),identifier);window=holder.value
    if not window:return None
    table=C.c_void_p.from_address(window+8).value;displacement=C.c_int.from_address(table+4).value
    if not 0<=displacement<=8192:fail('OFFICE_KIT_WINDOW_ABI_MISMATCH','Office 窗口引用布局与绑定版本不符。')
    reference=window+8+displacement
    try:
        system=vcl_window_system(window)
        # SystemEnvData on Windows: SalFrame*, widget*, HWND.
        return C.c_void_p.from_address(system+16).value if system else None
    finally:vcl_release(reference)

def native_event_fence():
    # Run inside the existing UI callback with RPC reentry excluded. Native
    # key/IME events can enqueue accelerators and callback flushes, so continue
    # until the real current event queue is empty, with a bounded busy result.
    # Reschedule itself restores the LOK document/view after nested dispatch.
    if not pump.executing or not vcl_main_thread() or vcl_system_loop():fail('NATIVE_EVENT_FENCE_UNAVAILABLE','Office 输入确认必须在受控的原生事件线程中执行。')
    deadline=time.monotonic()+2.0;passes=0
    while vcl_reschedule(True):
        passes+=1
        if time.monotonic()>=deadline:fail('NATIVE_EVENT_FENCE_BUSY','Office 原生事件仍在处理，输入结果未被重复执行，请等待后确认文档状态。')
    return passes
def kit_string(pointer):
    if not pointer:return ''
    try:return C.string_at(pointer).decode('utf-8','replace')
    finally:C.CFUNCTYPE(None,P)(abi_table(office,OfficeTable).freeError)(pointer)
def kit_error():return kit_string(office_call('getError',P)())
def kit_size(session):
    w=L();h=L();doc_call(session,'getDocumentSize',None,C.POINTER(L),C.POINTER(L))(C.byref(w),C.byref(h))
    if w.value<=0 or h.value<=0:fail('OFFICE_KIT_LAYOUT_UNAVAILABLE','Office 引擎尚未产生有效排版。')
    return {'width':w.value,'height':h.value}
def checked_integer(value,minimum,maximum,code='INVALID_OFFICE_SURFACE_INPUT'):
    if type(value) is not int or not minimum<=value<=maximum:fail(code,'Office 输入数值超出范围。')
    return value
def rect_values(value):
    if not isinstance(value,dict) or not all(isinstance(value.get(k),(int,float)) and not isinstance(value[k],bool) and math.isfinite(value[k]) for k in ['x','y','width','height']) or value['width']<0 or value['height']<0:fail('INVALID_OFFICE_SURFACE_BOUNDS','Office 内容区域无效。')
    return {k:float(value[k]) for k in ['x','y','width','height']}
def parse_rect(value):
    if not value or value=='EMPTY':return None
    if isinstance(value,dict):
        value=value.get('rectangle',value.get('rect'))
    if not isinstance(value,str):return None
    items=value.split(',')
    if len(items)<4:return None
    try:
        x,y,w,h=(float(v.strip()) for v in items[:4])
        if not all(math.isfinite(v) for v in [x,y,w,h]) or w<0 or h<0:return None
        return {'x':x,'y':y,'width':w,'height':h}
    except:return None
def parse_rects(payload):return [v for p in payload.split(';') if (v:=parse_rect(p)) is not None]
def overlaps(a,b):return a['x']+a['width']>b['x'] and b['x']+b['width']>a['x'] and a['y']+a['height']>b['y'] and b['y']+b['height']>a['y']
def native_rect(value):
    p=value.getPosition() if hasattr(value,'getPosition') else value.Position;s=value.getSize() if hasattr(value,'getSize') else value.Size;factor=1440/2540
    return {'x':p.X*factor,'y':p.Y*factor,'width':s.Width*factor,'height':s.Height*factor}
`;
