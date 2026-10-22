/** Bundled pyuno worker. Materialized by the trusted main process, never by document content. */
import { nativeOfficeAccessibilitySource } from './accessibility-source';
import { nativeOfficeAppearanceSource } from './appearance-source';
import { nativeOfficeStyleSource } from './native-style-source';
import { officeAuthoringSource } from './authoring-source';
const nativeOfficeWorkerBody = String.raw`
import base64, ctypes as C, hashlib, io, json, math, os, pathlib, queue, re, shutil, socket, struct, subprocess, sys, tempfile, threading, time, urllib.parse, uuid, zipfile, zlib
import xml.etree.ElementTree as ET
from ctypes import wintypes as W
import uno, unohelper
from com.sun.star.util import XModifyListener
from com.sun.star.view import XSelectionChangeListener
from com.sun.star.frame import XStatusListener, XDispatch, XDispatchProviderInterceptor
from com.sun.star.document import XDocumentEventListener, XUndoAction
from com.sun.star.task import XInteractionHandler
from com.sun.star.frame import XDispatchResultListener
from com.sun.star.datatransfer.dnd import XDropTargetListener

ROOT=pathlib.Path(sys.argv[1]).resolve(); PROGRAM=pathlib.Path(sys.argv[2]).resolve(); ROOT.mkdir(parents=True,exist_ok=True)
sessions={}; output_lock=threading.Lock(); requests=queue.Queue(maxsize=64); epoch=str(uuid.uuid4()); quitting=False
def emit(value):
    with output_lock: sys.stdout.write(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n');sys.stdout.flush()
def fail(code,message): raise RuntimeError(code+'|'+message)
def props(values):
    result=[]
    for name,value in values.items():
        p=uno.createUnoStruct('com.sun.star.beans.PropertyValue');p.Name=name;p.Value=value;result.append(p)
    return tuple(result)
def constant(name,fallback):
    try:return uno.getConstantByName(name)
    except:return fallback
def read_input():
    try:
        for line in sys.stdin:
            if len(line)>150*1024*1024:emit({'type':'diagnostic','code':'NATIVE_PROTOCOL_LIMIT'});continue
            try:requests.put(json.loads(line))
            except:emit({'type':'diagnostic','code':'NATIVE_PROTOCOL_ERROR'})
    finally:requests.put({'method':'shutdown','args':{'discard':False},'id':'stdin-closed'})
threading.Thread(target=read_input,daemon=True).start()

user32=C.WinDLL('user32',use_last_error=True);gdi32=C.WinDLL('gdi32',use_last_error=True)
kernel32=C.WinDLL('kernel32',use_last_error=True)
def sig(dll,name,ret,args):
    f=getattr(dll,name);f.restype=ret;f.argtypes=args;return f
sig(user32,'GetWindowLongW',C.c_long,[W.HWND,C.c_int]);sig(user32,'SetWindowLongW',C.c_long,[W.HWND,C.c_int,C.c_long]);sig(user32,'SetWindowLongPtrW',C.c_ssize_t,[W.HWND,C.c_int,C.c_ssize_t])
sig(user32,'GetWindow',W.HWND,[W.HWND,W.UINT]);sig(user32,'IsWindow',W.BOOL,[W.HWND]);sig(user32,'IsWindowVisible',W.BOOL,[W.HWND]);sig(user32,'IsIconic',W.BOOL,[W.HWND]);sig(user32,'GetForegroundWindow',W.HWND,[])
sig(user32,'GetDpiForWindow',W.UINT,[W.HWND]);sig(user32,'GetWindowRect',W.BOOL,[W.HWND,C.POINTER(W.RECT)]);sig(user32,'GetClientRect',W.BOOL,[W.HWND,C.POINTER(W.RECT)]);sig(user32,'ClientToScreen',W.BOOL,[W.HWND,C.POINTER(W.POINT)])
sig(user32,'GetWindowThreadProcessId',W.DWORD,[W.HWND,C.POINTER(W.DWORD)]);sig(user32,'SetThreadDpiAwarenessContext',C.c_void_p,[C.c_void_p]);sig(user32,'GetWindowDpiAwarenessContext',C.c_void_p,[W.HWND]);sig(user32,'AreDpiAwarenessContextsEqual',W.BOOL,[C.c_void_p,C.c_void_p])
sig(user32,'SetWindowPos',W.BOOL,[W.HWND,W.HWND,C.c_int,C.c_int,C.c_int,C.c_int,W.UINT]);sig(user32,'ShowWindow',W.BOOL,[W.HWND,C.c_int]);sig(user32,'PrintWindow',W.BOOL,[W.HWND,W.HDC,W.UINT])
sig(user32,'GetDC',W.HDC,[W.HWND]);sig(user32,'ReleaseDC',C.c_int,[W.HWND,W.HDC]);sig(gdi32,'CreateCompatibleDC',W.HDC,[W.HDC]);sig(gdi32,'SelectObject',W.HANDLE,[W.HDC,W.HANDLE]);sig(gdi32,'DeleteObject',W.BOOL,[W.HANDLE]);sig(gdi32,'DeleteDC',W.BOOL,[W.HDC])
sig(user32,'SetForegroundWindow',W.BOOL,[W.HWND]);sig(user32,'SetCursorPos',W.BOOL,[C.c_int,C.c_int]);sig(user32,'PostMessageW',W.BOOL,[W.HWND,W.UINT,W.WPARAM,W.LPARAM]);sig(user32,'SendInput',W.UINT,[W.UINT,C.c_void_p,C.c_int])
sig(user32,'SendMessageTimeoutW',C.c_ssize_t,[W.HWND,W.UINT,W.WPARAM,W.LPARAM,W.UINT,W.UINT,C.POINTER(C.c_size_t)])
sig(user32,'GetAsyncKeyState',C.c_short,[C.c_int])
sig(user32,'AttachThreadInput',W.BOOL,[W.DWORD,W.DWORD,W.BOOL]);sig(kernel32,'GetCurrentThreadId',W.DWORD,[])
sig(user32,'PeekMessageW',W.BOOL,[C.POINTER(W.MSG),W.HWND,W.UINT,W.UINT,W.UINT])
sig(user32,'GetMenu',W.HMENU,[W.HWND]);sig(user32,'SetMenu',W.BOOL,[W.HWND,W.HMENU]);sig(user32,'DrawMenuBar',W.BOOL,[W.HWND])
sig(user32,'GetWindowTextW',C.c_int,[W.HWND,W.LPWSTR,C.c_int])
user32.SetThreadDpiAwarenessContext(C.c_void_p(-4))
SYSTEM_WIN32=constant('com.sun.star.lang.SystemDependent.SYSTEM_WIN32',1)
imm32=C.WinDLL('imm32',use_last_error=True)
class GUI_THREAD_INFO(C.Structure):
    _fields_=[('size',W.DWORD),('flags',W.DWORD),('active',W.HWND),('focus',W.HWND),('capture',W.HWND),('menuOwner',W.HWND),('moveSize',W.HWND),('caret',W.HWND),('caretRect',W.RECT)]
sig(user32,'GetGUIThreadInfo',W.BOOL,[W.DWORD,C.POINTER(GUI_THREAD_INFO)]);sig(user32,'GetAncestor',W.HWND,[W.HWND,W.UINT]);sig(user32,'IsChild',W.BOOL,[W.HWND,W.HWND])
sig(imm32,'ImmGetContext',W.HANDLE,[W.HWND]);sig(imm32,'ImmReleaseContext',W.BOOL,[W.HWND,W.HANDLE]);sig(imm32,'ImmGetCompositionStringW',C.c_long,[W.HANDLE,W.DWORD,C.c_void_p,W.DWORD])

def own_ime_pending(view):
    if not view.get('visible') or not user32.IsWindowVisible(view['hwnd']):return False
    pid=W.DWORD();thread_id=user32.GetWindowThreadProcessId(view['hwnd'],C.byref(pid));info=GUI_THREAD_INFO();info.size=C.sizeof(info)
    if not user32.GetGUIThreadInfo(thread_id,C.byref(info)):return False
    focus=int(info.focus or info.caret or 0)
    if not focus:return False
    candidate_pid=W.DWORD();user32.GetWindowThreadProcessId(focus,C.byref(candidate_pid))
    if candidate_pid.value!=pid.value:return False
    own=focus==view['hwnd'] or bool(user32.IsChild(view['hwnd'],focus));ancestor=int(user32.GetAncestor(focus,2) or focus)
    for _ in range(12):
        if ancestor==view['hwnd']:own=True;break
        ancestor=int(user32.GetWindow(ancestor,4) or 0)
        if not ancestor:break
    if not own:return False
    context=imm32.ImmGetContext(focus)
    if not context:return False
    try:return imm32.ImmGetCompositionStringW(context,8,None,0)>0
    finally:imm32.ImmReleaseContext(focus,context)
def native_handle(frame):return int(frame.getContainerWindow().getWindowHandle((),SYSTEM_WIN32))
def rectangle(hwnd,client=False):
    r=W.RECT();ok=(user32.GetClientRect if client else user32.GetWindowRect)(hwnd,C.byref(r))
    if not ok:fail('NATIVE_WINDOW_GONE','原生编辑窗口已关闭。')
    return {'x':r.left,'y':r.top,'width':r.right-r.left,'height':r.bottom-r.top}

def coordinate_scale(client,viewport):
    if not viewport or not all(isinstance(viewport.get(name),(int,float)) and not isinstance(viewport[name],bool) and math.isfinite(viewport[name]) and viewport[name]>0 for name in ['width','height']):fail('INVALID_NATIVE_BOUNDS','阅读器视口尺寸无效。')
    scale=client['width']/viewport['width']
    if not math.isfinite(scale) or scale<=0 or abs(viewport['height']*scale-client['height'])>2:fail('NATIVE_GEOMETRY_MISMATCH','阅读器实际像素与视口比例尚未一致。')
    return scale

def surface_geometry(bounds,client,origin,scale):
    x=round(bounds['x']*scale);y=round(bounds['y']*scale)
    right=min(client['width'],round((bounds['x']+bounds['width'])*scale));bottom=min(client['height'],round((bounds['y']+bounds['height'])*scale))
    return {'x':origin['x']+x,'y':origin['y']+y,'width':max(0,right-x),'height':max(0,bottom-y)}

def view_scale(view):
    scale=view.get('coordinateScale')
    if not isinstance(scale,(int,float)) or isinstance(scale,bool) or not math.isfinite(scale) or scale<=0:fail('NATIVE_GEOMETRY_UNAVAILABLE','原生区域尚未确认坐标比例。')
    return scale

def native_geometry(view,client=None,screen=None):
    target=view.get('targetBounds');scale=view.get('coordinateScale')
    if not target or not scale or not view.get('visible') or not user32.IsWindow(view['owner']) or user32.IsIconic(view['owner']) or not user32.IsWindowVisible(view['owner']) or not user32.IsWindowVisible(view['hwnd']):return False
    client=client or rectangle(view['hwnd'],True);screen=screen or rectangle(view['hwnd'])
    return target['width']>0 and target['height']>0 and all(abs(screen[name]-target[name])<=2 for name in ['x','y','width','height']) and abs(client['width']-target['width'])<=2 and abs(client['height']-target['height'])<=2

def refresh_content_dirtiness(session):
    dirty=bool(session['doc'].isModified())
    if dirty:session['unsavedContentChanges']=True
    else:session.setdefault('unsavedContentChanges',False)
    return dirty

def saved_ack_notification(session):
    acknowledgement=session.get('acknowledgingSave')
    if acknowledgement is None:return False
    try:return not session['doc'].isModified() and session['engineRevision']==acknowledgement['engineRevision'] and undo_state(session)==acknowledgement['undo']
    except:return False

class Modified(unohelper.Base,XModifyListener):
    def __init__(self,session):self.session=session
    def modified(self,event):
        try:refresh_content_dirtiness(self.session)
        except:pass
        if saved_ack_notification(self.session):return
        self.session['engineRevision']+=1;self.session['actor']=self.session.get('operationActor') or 'human';emit({'type':'changed','sessionId':self.session['sessionId'],'engineRevision':self.session['engineRevision'],'actor':self.session['actor']})
    def disposing(self,event):self.session['disposed']=True;emit({'type':'closed','sessionId':self.session['sessionId']})
class SelectionChanged(unohelper.Base,XSelectionChangeListener):
    def __init__(self,session,view):self.session=session;self.view=view
    def selectionChanged(self,event):
        update_selection_epoch(self.session,self.view,selection(self.session,self.view))
    def disposing(self,event):self.view['disposed']=True
class DocumentEvents(unohelper.Base,XDocumentEventListener):
    def __init__(self,session):self.session=session
    def documentEventOccured(self,event):
        if not self.session.get('exporting') and event.EventName in ['OnSaveDone','OnSaveAsDone']:emit({'type':'saved','sessionId':self.session['sessionId'],'engineRevision':self.session['engineRevision']})
    def disposing(self,event):pass
class Status(unohelper.Base,XStatusListener):
    def __init__(self):self.received=False;self.enabled=False;self.value=None
    def statusChanged(self,event):
        self.received=True;self.enabled=bool(event.IsEnabled);self.value=event.State if isinstance(event.State,(str,int,float,bool)) else None
    def disposing(self,event):pass
class SafeImportInteraction(unohelper.Base,XInteractionHandler):
    def handle(self,request):
        # Imports must not approve repair, macros, external links or credential prompts.
        for continuation in request.getContinuations():
            try:types=[v.typeName for v in continuation.getTypes()]
            except:types=[]
            if 'com.sun.star.task.XInteractionAbort' in types or 'com.sun.star.task.XInteractionDisapprove' in types:
                continuation.select();emit({'type':'diagnostic','code':'NATIVE_IMPORT_INTERACTION_ABORTED'});return
        fail('NATIVE_IMPORT_INTERACTION','文档导入需要明确处理的交互，未自动批准。')
MANAGED_ACTIONS={'.uno:Save':'save','.uno:SaveAs':'save-as','.uno:SaveAll':'save-all','.uno:Open':'open','.uno:OpenUrl':'open','.uno:NewDoc':'new','.uno:CloseDoc':'close','.uno:CloseWin':'close','.uno:Quit':'quit','.uno:NewWindow':'new-window'}
class ManagedDispatch(unohelper.Base,XDispatch):
    def __init__(self,view,command):self.view=view;self.command=command
    def dispatch(self,target,args):emit({'type':'application-action','sessionId':self.view['sessionId'],'viewId':self.view['viewId'],'action':MANAGED_ACTIONS[self.command]})
    def addStatusListener(self,listener,target):
        event=uno.createUnoStruct('com.sun.star.frame.FeatureStateEvent');event.Source=self;event.FeatureURL=target;event.IsEnabled=True;event.State=None;listener.statusChanged(event)
    def removeStatusListener(self,listener,target):pass
class ManagedInterceptor(unohelper.Base,XDispatchProviderInterceptor):
    def __init__(self,view):self.view=view;self.slave=None;self.master=None;self.dispatches={}
    def queryDispatch(self,target,name,flags):
        command=target.Complete
        if command in MANAGED_ACTIONS and not self.view.get('internalManaged'):
            if command not in self.dispatches:self.dispatches[command]=ManagedDispatch(self.view,command)
            return self.dispatches[command]
        return self.slave.queryDispatch(target,name,flags) if self.slave else None
    def queryDispatches(self,descriptors):return tuple(self.queryDispatch(d.FeatureURL,d.FrameName,d.SearchFlags) for d in descriptors)
    def setSlaveDispatchProvider(self,provider):self.slave=provider
    def getSlaveDispatchProvider(self):return self.slave
    def setMasterDispatchProvider(self,provider):self.master=provider
    def getMasterDispatchProvider(self):return self.master

class DispatchCompleted(unohelper.Base,XDispatchResultListener):
    def __init__(self,session,view,request_id):self.session=session;self.view=view;self.request_id=request_id
    def dispatchFinished(self,event):
        self.view.get('pendingDispatches',{}).pop(self.request_id,None)
        emit({'type':'dispatch-finished','sessionId':self.session['sessionId'],'viewId':self.view['viewId'],'requestId':self.request_id,'resultState':int(event.State),'engineRevision':self.session['engineRevision']})
    def disposing(self,event):self.view.get('pendingDispatches',{}).pop(self.request_id,None)

def sidebar_state(view):
    # Public .uno:Sidebar is an application-managed chrome command. Its policy
    # result is not a visibility probe; query the actual native UI provider.
    try:
        sidebar=view['controller'].getSidebar()
        if sidebar is None:return {}
        if not sidebar.isVisible():return {'sidebar':False}
    except:return {}
    try:
        decks=sidebar.getDecks()
        for name in decks.getElementNames():
            deck=decks.getByName(name)
            # isVisible() means a SidebarController exists, even when collapsed.
            # isActive() reads IsDeckVisible: the matching deck is actually open.
            if deck.isActive():return {'sidebar':True,'deckId':str(deck.getId())}
        return {'sidebar':False}
    except:return {} # A pending collection does not prove visible or closed.

def observe_requested_deck(view,actual):
    if not view.get('requestedDeck') or view.get('visible') is False:return
    if actual.get('sidebar'):view['requestedDeckShown']=True
    elif actual.get('sidebar') is False and view.get('requestedDeckShown'):
        # Only a previously displayed native deck can have been closed. A slow
        # asynchronous creation must not be mistaken for the user's close action.
        view.pop('requestedDeck',None);view.pop('requestedDeckShown',None)

def dispatch_command(session,view,command,values,request_id):
    # Unlike DispatchHelper.executeDispatch, native dialogs must not hold the JSONL queue.
    status=command_status(view,command)
    if not status['enabled']:fail('NATIVE_COMMAND_DISABLED','此命令对当前目标不可用。')
    if command in ['.uno:DesignerDialog','.uno:CustomAnimation','.uno:SlideChangeWindow','.uno:MasterSlidesPanel']:
        view['requestedDeck']=command;view['requestedDeckShown']=sidebar_state(view).get('sidebar') is True
        try:view['frame'].LayoutManager.setVisible(True)
        except:pass
    target=url(command);dispatch=view['frame'].queryDispatch(target,'',0)
    values=dict(values);values['SynchronMode']=False
    try:notification=dispatch.queryInterface(uno.getTypeByName('com.sun.star.frame.XNotifyingDispatch'))
    except:notification=None
    if notification is not None:
        listener=DispatchCompleted(session,view,request_id);view.setdefault('pendingDispatches',{})[request_id]=listener
        try:notification.dispatchWithNotification(target,props(values),listener)
        except:view['pendingDispatches'].pop(request_id,None);raise
    else:dispatch.dispatch(target,props(values))
    return 'dispatched'

DOCUMENT_DROP_SUFFIXES={'.md','.markdown','.doc','.docx','.ppt','.pptx','.xls','.xlsx','.pdf','.html','.htm','.epub','.odt','.ods','.odp'}
def file_drop_paths(value):
    if isinstance(value,str):text=value
    else:
        data=bytes((int(v)&255 for v in getattr(value,'value',value)));text=data.decode('utf-16-le') if b'\0' in data else data.decode('utf-8')
    paths=[]
    for item in re.split(r'[\0\r\n]+',text):
        item=item.strip()
        if not item or item.startswith('#'):continue
        if item.lower().startswith('file:'):
            try:item=uno.fileUrlToSystemPath(item)
            except:return []
        if not re.match(r'^(?:[A-Za-z]:[\\/]|\\\\)',item) or any(ord(c)<32 for c in item):return []
        path=pathlib.Path(item)
        if path.suffix.lower() not in DOCUMENT_DROP_SUFFIXES:return []
        paths.append(str(path))
    return list(dict.fromkeys(paths))[:100]

class DocumentFileDrop(unohelper.Base,XDropTargetListener):
    def __init__(self,view):self.view=view;self.has_files=False
    def dragEnter(self,event):
        self.has_files=any(v.MimeType.split(';')[0].lower() in ['application/x-openoffice-filelist','text/uri-list'] for v in event.SupportedDataFlavors)
        if self.has_files:event.Context.acceptDrag(constant('com.sun.star.datatransfer.dnd.DNDConstants.ACTION_COPY',1))
    def dragOver(self,event):
        if self.has_files:event.Context.acceptDrag(constant('com.sun.star.datatransfer.dnd.DNDConstants.ACTION_COPY',1))
    def dropActionChanged(self,event):self.dragOver(event)
    def dragExit(self,event):self.has_files=False
    def disposing(self,event):self.has_files=False
    def drop(self,event):
        paths=[]
        for flavor in event.Transferable.getTransferDataFlavors():
            if flavor.MimeType.split(';')[0].lower() not in ['application/x-openoffice-filelist','text/uri-list']:continue
            try:paths=file_drop_paths(event.Transferable.getTransferData(flavor))
            except:paths=[]
            if paths:break
        if not paths:return # Native text, objects, images and mixed image lists keep their own handlers.
        # VCL rejectDrop is a no-op; completing consumes its shared context before other listeners.
        event.Context.acceptDrop(constant('com.sun.star.datatransfer.dnd.DNDConstants.ACTION_COPY',1));event.Context.dropComplete(True)
        emit({'type':'application-action','sessionId':self.view['sessionId'],'viewId':self.view['viewId'],'action':'open-files','paths':paths})

def register_file_drop(view):
    try:
        window=view['frame'].getComponentWindow();target=window.getToolkit().getDropTarget(window)
        listener=view.get('fileDropListener')
        if listener is not None:target.removeDropTargetListener(listener)
        else:listener=DocumentFileDrop(view)
        target.addDropTargetListener(listener);view['fileDropListener']=listener;view['fileDropTarget']=target
    except:view['fileDropUnavailable']=True

def url(command):
    value=uno.createUnoStruct('com.sun.star.util.URL');value.Complete=command
    try:
        parsed=transformer.parseStrict(value)
        if isinstance(parsed,tuple) and len(parsed)>1:value=parsed[1]
    except:pass
    return value
def command_status(view,command):
    try:
        target=url(command);dispatch=view['frame'].queryDispatch(target,'',0)
        if dispatch is None:return {'command':command,'available':False,'enabled':False}
        listener=Status();dispatch.addStatusListener(listener,target);dispatch.removeStatusListener(listener,target)
        return {'command':command,'available':True,'enabled':listener.enabled if listener.received else False,'state':listener.value}
    except:return {'command':command,'available':False,'enabled':False}
def controllers(doc):
    enumeration=doc.getControllers();items=[]
    while enumeration.hasMoreElements():items.append(enumeration.nextElement())
    return items
def session_for(args):
    session=sessions.get(args.get('sessionId'))
    if not session or session.get('disposed'):fail('NATIVE_SESSION_NOT_FOUND','原生文档会话不存在。')
    return session
def view_for(session,args):
    view=session['views'].get(args.get('viewId') or session['activeViewId'])
    if not view or view.get('disposed') or not user32.IsWindow(view['hwnd']):fail('NATIVE_VIEW_NOT_FOUND','原生阅读视图已关闭。')
    return view
def expected(session,view,args):
    if args.get('expectedEngineEpoch') is not None and args['expectedEngineEpoch']!=epoch:fail('ENGINE_EPOCH_CHANGED','原生引擎已经重启，请重新读取。')
    if args.get('expectedEngineRevision')!=session['engineRevision']:fail('REVISION_CONFLICT','原生文档已变化，请重新读取。')
    if args.get('expectedSelectionEpoch') is not None:
        selected=selection(session,view);update_selection_epoch(session,view,selected,False)
        if args.get('style',{}).get('target') in ['text','paragraph','shape'] and selected.get('identityUnavailable'):fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前原生目标没有可验证的范围身份。')
        if args['expectedSelectionEpoch']!=view['selectionEpoch']:fail('SELECTION_CHANGED','原生选区已变化，请重新读取。')

def hide_chrome(view):
    layout=view['frame'].LayoutManager
    try:
        if not view.get('requestedDeck'):layout.setVisible(False)
    except:pass
    for element in layout.getElements():
        resource=element.ResourceURL
        if '/toolbar/' in resource or '/menubar/' in resource or '/statusbar/' in resource:
            try:layout.hideElement(resource)
            except:pass
    for command in ['.uno:Sidebar','.uno:LeftPaneImpress','.uno:Ruler','.uno:InputLineVisible']:
        if command=='.uno:Sidebar' and view.get('requestedDeck'):continue
        status=command_status(view,command)
        if status['enabled'] and status.get('state') is True:
            try:dispatcher.executeDispatch(view['frame'],command,'',0,())
            except:pass
    user32.SetMenu(view['hwnd'],None);user32.DrawMenuBar(view['hwnd'])
    try:view['frame'].getContainerWindow().setMenuBar(None)
    except:pass
    try:
        if view['controller'].hasInfobar('macro'):view['controller'].removeInfobar('macro');view['macroNoticeInMetadata']=True
    except:pass
def attach(session,controller,args):
    frame=controller.getFrame();hwnd=native_handle(frame);owner=int(args['ownerHwnd'])
    if not user32.IsWindow(owner):fail('INVALID_NATIVE_OWNER','阅读器窗口已经关闭。')
    old_dpi=user32.GetWindowDpiAwarenessContext(hwnd)
    style=user32.GetWindowLongW(hwnd,-16);user32.SetWindowLongW(hwnd,-16,(style&~0x40CF0000)|0x80000000)
    user32.SetWindowLongPtrW(hwnd,-8,owner);ex=user32.GetWindowLongW(hwnd,-20);user32.SetWindowLongW(hwnd,-20,(ex&~0x40000)|0x80)
    if not user32.AreDpiAwarenessContextsEqual(old_dpi,user32.GetWindowDpiAwarenessContext(hwnd)):fail('NATIVE_DPI_CHANGED','原生编辑器 DPI 状态发生变化。')
    view={'viewId':args['viewId'],'sessionId':session['sessionId'],'format':session['format'],'controller':controller,'frame':frame,'hwnd':hwnd,'owner':owner,'bounds':args['bounds'],'visible':bool(args.get('visible',True)),'selectionEpoch':0,'disposed':False,'layoutRevision':0,'actor':'human'}
    listener=SelectionChanged(session,view);controller.addSelectionChangeListener(listener);view['selectionListener']=listener
    interceptor=ManagedInterceptor(view);frame.registerDispatchProviderInterceptor(interceptor);view['interceptor']=interceptor
    session['views'][args['viewId']]=view;session['activeViewId']=args['viewId'];sync_native_view_appearance(view);hide_chrome(view);layout_view(view,args);register_file_drop(view)
    return view
def layout_view(view,args):
    owner=int(args.get('ownerHwnd',view['owner']));bounds=args.get('bounds',view['bounds']);visible=bool(args.get('visible',view['visible']))
    if not user32.IsWindow(owner):visible=False
    if owner!=view['owner'] and user32.IsWindow(owner):user32.SetWindowLongPtrW(view['hwnd'],-8,owner)
    view['owner']=owner;view['bounds']=bounds;view['visible']=visible;view['ownerViewport']=args.get('ownerViewport',view.get('ownerViewport'))
    if not user32.IsWindow(owner):view.pop('targetBounds',None);user32.ShowWindow(view['hwnd'],0);return
    if user32.IsIconic(owner):user32.ShowWindow(view['hwnd'],0);return
    client=rectangle(owner,True);density=coordinate_scale(client,view['ownerViewport']);point=W.POINT(0,0)
    if not user32.ClientToScreen(owner,C.byref(point)):fail('NATIVE_GEOMETRY_UNAVAILABLE','阅读器原点无法确认。')
    target=surface_geometry(bounds,client,{'x':point.x,'y':point.y},density);view['targetBounds']=target
    if view.get('coordinateScale')!=density:view['layoutRevision']+=1;view.pop('captureCache',None);view.pop('accessibilityCache',None)
    view['coordinateScale']=density;point.x=target['x'];point.y=target['y'];width=target['width'];height=target['height']
    if not visible or user32.IsIconic(owner) or not user32.IsWindowVisible(owner):user32.ShowWindow(view['hwnd'],0);return
    if width<1 or height<1:user32.ShowWindow(view['hwnd'],0);return
    # Show first: SW_SHOWNOACTIVATE otherwise restores LibreOffice's old placement after SetWindowPos.
    old_ex=user32.GetWindowLongW(view['hwnd'],-20);user32.SetWindowLongW(view['hwnd'],-20,old_ex|0x08000000)
    try:view['frame'].getContainerWindow().setVisible(True);view['frame'].getComponentWindow().setVisible(True)
    finally:user32.SetWindowLongW(view['hwnd'],-20,old_ex)
    hide_chrome(view)
    register_file_drop(view)
    user32.ShowWindow(view['hwnd'],4);user32.SetWindowPos(view['hwnd'],None,point.x,point.y,width,height,0x20|0x10)
    actual=rectangle(view['hwnd'])
    if view.get('actualBounds')!=actual:view['layoutRevision']+=1;view['actualBounds']=actual;view.pop('captureCache',None)

def letter(column):
    value='';column+=1
    while column:column,remainder=divmod(column-1,26);value=chr(65+remainder)+value
    return value
def range_name(address):
    start=letter(address.StartColumn)+str(address.StartRow+1);end=letter(address.EndColumn)+str(address.EndRow+1)
    return start if start==end else start+':'+end
def selected_text_range(session,view):
    if session['format'] not in ['docx','pptx']:return None
    try:
        selected=view['controller'].getSelection()
        if session['format']=='docx':
            if selected.getCount()!=1:return None
            selected=selected.getByIndex(0)
        elif hasattr(selected,'getCount'):return None # Selected objects are not a text editing range.
        value=selected.queryInterface(uno.getTypeByName('com.sun.star.text.XTextRange'))
        if value is None or not value.getString() or len(value.getString())>48000:return None
        return value
    except:return None

def selection_actions(session,view,selected):
    if selected['kind']!='text' or not selected['text']:return []
    actions=[]
    for action,command in [('bold','.uno:Bold'),('italic','.uno:Italic'),('underline','.uno:Underline'),('strike','.uno:Strikeout'),('align-left','.uno:LeftPara'),('align-center','.uno:CenterPara')]:
        if command_status(view,command)['enabled']:actions.append(action)
    value=selected_text_range(session,view)
    if value is not None and value.getString()==selected['text']:actions.append('replace')
    return actions

def ppt_text_parts(full,positions):
    full=full.replace('\r\n','\n').replace('\r','\n');lines=full.split('\n');offsets=[]
    for paragraph,position in [positions[:2],positions[2:]]:
        if paragraph>=len(lines) or position>len(lines[paragraph].encode('utf-16-le'))//2:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','实际文字范围超出对象内容。')
        offsets.append(sum(len(line.encode('utf-16-le'))//2+1 for line in lines[:paragraph])+position)
    encoded=full.encode('utf-16-le')
    try:return tuple(encoded[a*2:b*2].decode('utf-16-le') for a,b in [(0,offsets[0]),(offsets[0],offsets[1]),(offsets[1],len(encoded)//2)])
    except UnicodeError:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','实际文字范围没有完整字符边界。')

def ppt_text_transaction_target(session,view,value,whole_shape=False):
    text=value.Text;shape=text.queryInterface(uno.getTypeByName('com.sun.star.drawing.XShape'));page=view['controller'].getCurrentPage()
    if shape is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字范围不属于可验证的真实幻灯片对象。')
    try:index=shape.getPropertyValue('ZOrder')
    except:index=-1
    if type(index) is not int or index<0 or index>=page.getCount() or page.getByIndex(index)!=shape:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字对象不属于该页的唯一顶层对象。')
    pages=session['doc'].getDrawPages();slide=next((i for i in range(pages.getCount()) if pages.getByIndex(i)==page),None)
    if slide is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前幻灯片身份不可用。')
    native=value.getPropertyValue('Selection');positions=[native.Start.Paragraph,native.Start.PositionInParagraph,native.End.Paragraph,native.End.PositionInParagraph]
    if any(type(v) is not int or v<0 for v in positions) or tuple(positions[:2])>tuple(positions[2:]):fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前原生文字范围位置无效。')
    full=text.getString()
    if not whole_shape and len(full.encode('utf-16-le'))//2>48000:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字对象超出可验证的字符范围。')
    prefix,selected,suffix=ppt_text_parts(full,positions);actual=value.getString()
    if selected!=actual.replace('\r\n','\n').replace('\r','\n'):fail('SELECTION_CHANGED','实际文字范围与对象内容不一致。')
    return {'text':text,'shape':shape,'page':page,'index':index,'slide':slide,'nativeSelection':native,'positions':positions,'expectedText':actual,'fullText':full,'prefix':prefix,'suffix':suffix}
def ppt_text_model_range(session,view,target,args):
    # Official SdUnoDrawView::setCurrentPage always commits SdrEndTextEdit, even
    # for the same page. An active viewless UNO cursor otherwise edits a copy
    # which the live Outliner immediately replaces on the next getter.
    view['controller'].setCurrentPage(target['page'])
    expected(session,view,{key:value for key,value in args.items() if key!='expectedSelectionEpoch'})
    page=view['controller'].getCurrentPage()
    if page!=target['page'] or target['index']>=page.getCount() or page.getByIndex(target['index'])!=target['shape']:fail('SELECTION_CHANGED','真实文字对象已变化，没有猜测目标。')
    if target['shape'].getText().getString()!=target['fullText']:fail('SELECTION_CHANGED','结束编辑后对象内容已变化，没有继续修改。')
    model=target['shape'].getText().createTextCursor();model.setPropertyValue('Selection',target['nativeSelection'])
    if model.getString()!=target['expectedText']:fail('SELECTION_CHANGED','结束编辑后真实文字范围已变化，没有继续修改。')
    return model
def ppt_replace_text(session,view,target,replacement,args):
    model=ppt_text_model_range(session,view,target,args)
    if model.getString()!=replacement['expectedText']:fail('SELECTION_CHANGED','实际文字范围已变化，没有替换。')
    command='.uno:TransformDocumentStructure';dispatch=view['frame'].queryDispatch(url(command),'',0)
    if dispatch is None:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前原生引擎不提供绑定对象的文字编辑事务。')
    # This fixed typed payload never accepts caller JSON or nested UnoCommand.
    payload={'Transforms':[{'SlideCommands':[{'JumpToSlide':target['slide']},{'EditTextObject.'+str(target['index']):[{'SelectText':target['positions']},{'InsertText':replacement['text']}]}]}]}
    dispatcher.executeDispatch(view['frame'],command,'',0,props({'DataJson':urllib.parse.quote(json.dumps(payload,ensure_ascii=False),safe=''),'SynchronMode':True}))
    changed=target['shape'].getText().createTextCursor();changed.gotoStart(False);changed.gotoEnd(True)
    native=uno.createUnoStruct('com.sun.star.text.TextRangeSelection');native.Start=target['nativeSelection'].Start;parts=replacement['text'].replace('\r\n','\n').replace('\r','\n').split('\n')
    # PyUNO nested structs are returned by value: mutating native.End.* would
    # mutate a temporary copy. Assign the complete real TextPosition instead.
    end=uno.createUnoStruct('com.sun.star.text.TextPosition');end.Paragraph=native.Start.Paragraph+len(parts)-1;end.PositionInParagraph=(native.Start.PositionInParagraph if len(parts)==1 else 0)+len(parts[-1].encode('utf-16-le'))//2;native.End=end
    inserted=target['shape'].getText().createTextCursor();inserted.setPropertyValue('Selection',native)
    normalized=replacement['text'].replace('\r\n','\n').replace('\r','\n')
    if inserted.getString().replace('\r\n','\n').replace('\r','\n')!=normalized:fail('NATIVE_STYLE_APPLY_FAILED','原生文字事务没有产生可验证的替换结果。')
    if changed.getString().replace('\r\n','\n').replace('\r','\n')!=target['prefix']+normalized+target['suffix']:fail('NATIVE_STYLE_APPLY_FAILED','原生文字对象的替换或未选中内容未通过验证，未报告成功。')
def ppt_set_shape_text(session,view,op,args):
    # Viewless SvxShapeText::setString updates an Nbc text copy without native
    # document undo/modify notifications. Use the same real Outliner transaction
    # as selection replacement, after binding the entire actual top-level shape.
    if args.get('background') or args.get('actor','agent')=='agent':
        page,shape=mapped_shape(session,op['slideId'],op['shapeId']);index=mapped_slide(session,op['slideId'])[1];position=next((position for position in range(page.getCount()) if page.getByIndex(position)==shape),None)
        if position is None:fail('INVALID_TARGET','原生顶层文字对象已经变化。')
        return authoring_replace_slide_text(session,view,{'slideIndex':index,'objectPath':[position],'expectedText':shape.getText().getString(),'text':op['text']},args)
    for candidate in session['views'].values():
        if candidate.get('disposed'):continue
        cached=candidate.get('accessibilityCache',{}).get('data')
        if own_ime_pending(candidate) or candidate.get('nativeEditing') or candidate.get('caretVisible') or cached and cached[2]:fail('NATIVE_PENDING_INPUT','幻灯片文字输入尚未提交，没有隐式结束另一视图的编辑。')
        if not candidate['frame'].getContainerWindow().isEnabled():fail('NATIVE_PENDING_INPUT','原生对话框尚未结束。')
    page,shape=mapped_shape(session,op['slideId'],op['shapeId'])
    try:
        if shape.supportsService('com.sun.star.drawing.GroupShape'):fail('NATIVE_STYLE_TARGET_UNAVAILABLE','组合对象不能作为唯一顶层文字目标。')
        text=shape.getText();full=text.getString();index=shape.getPropertyValue('ZOrder')
    except RuntimeError:raise
    except:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前对象不是可验证的原生文字对象。')
    if type(index) is not int or index<0 or index>=page.getCount() or page.getByIndex(index)!=shape:fail('NATIVE_STYLE_TARGET_UNAVAILABLE','当前文字对象不属于该页的唯一顶层对象。')
    if full==op['text']:return
    # Changing the page may retire a live Outliner. The all-view guard above
    # forbids pending input, and identity/content/version must still agree after it.
    view['controller'].setCurrentPage(page)
    expected(session,view,{key:value for key,value in args.items() if key!='expectedSelectionEpoch'})
    actual_page,actual_shape=mapped_shape(session,op['slideId'],op['shapeId'])
    if actual_page!=page or actual_shape!=shape or shape.getText().getString()!=full:fail('SELECTION_CHANGED','真实文字对象或全文已变化，没有猜测目标。')
    value=text.createTextCursor();value.gotoStart(False);value.gotoEnd(True)
    target=ppt_text_transaction_target(session,view,value,True)
    if target['shape']!=shape or target['page']!=page or target['index']!=index or target['fullText']!=full or target['prefix'] or target['suffix']:fail('SELECTION_CHANGED','原生全文范围不完整，没有替换。')
    ppt_replace_text(session,view,target,{'expectedText':value.getString(),'text':op['text']},args)
def replace_selected_text(session,view,replacement,args=None):
    value=selected_text_range(session,view)
    if value is None:fail('NATIVE_SELECTION_UNSUPPORTED','当前选区不是可直接编辑的实际文字范围。')
    if value.getString()!=replacement['expectedText']:fail('SELECTION_CHANGED','实际选区文字已变化，未替换。')
    if session['format']=='pptx':
        target=ppt_text_transaction_target(session,view,value);ppt_replace_text(session,view,target,replacement,args or {})
    else:value.setString(replacement['text'])
def selection_signature(selected):
    locator=selected.get('locator',{})
    return (selected['kind'],selected['text'],selected.get('sheetName'),selected.get('range'),selected.get('slideIndex'),tuple(selected.get('objectNames',[])),locator.get('from'),locator.get('to'),locator.get('cell'),locator.get('blockId'),bool(selected.get('identityUnavailable')))
def update_selection_epoch(session,view,selected,notify=True):
    signature=selection_signature(selected)
    if view.get('semanticSelection')==signature:return False
    view['semanticSelection']=signature;view['selectionEpoch']+=1;view['actor']=session.get('operationActor') or 'human'
    view.pop('accessibilityCache',None);view.pop('captureCache',None)
    if notify:emit({'type':'selection','sessionId':session['sessionId'],'viewId':view['viewId'],'engineRevision':session['engineRevision'],'actor':view['actor']})
    return True
def native_text_container_id(session,text):
    containers=session.setdefault('textContainers',[])
    for item in containers:
        if item['text']==text:return item['id']
    if len(containers)>=2048:fail('NATIVE_SELECTION_UNSUPPORTED','原生文字容器数量超出可验证范围。')
    identity='native-text-container:'+str(uuid.uuid4());containers.append({'text':text,'id':identity});return identity
def native_shape_identity(session,shape):
    objects=session.setdefault('shapeIdentities',[])
    for item in objects:
        if item['shape']==shape:return item['id']
    if len(objects)>=4096:fail('NATIVE_SELECTION_UNSUPPORTED','原生对象数量超出可验证范围。')
    identity='native-shape:'+str(uuid.uuid4());objects.append({'shape':shape,'id':identity});return identity
def native_range_locator(session,view,actual,content):
    text=actual.Text;identity=native_text_container_id(session,text);revision=session['engineRevision'];cache=view.setdefault('rangeLocatorCache',[])
    comparable=hasattr(text,'compareRegionStarts') and hasattr(text,'compareRegionEnds')
    if not comparable and session['format']!='pptx':fail('NATIVE_SELECTION_UNSUPPORTED','原生文字容器不提供精确范围比较。')
    for item in cache:
        if item['revision']!=revision or item['container']!=identity:continue
        try:
            if text.compareRegionStarts(actual,item['range'])==0 and text.compareRegionEnds(actual,item['range'])==0:return dict(item['locator'])
        except:pass
    # Writer viewport polls compare retained model ranges without rereading their
    # document prefix. Impress XText lacks that interface: read only the actual
    # selected shape's bounded prefix, never the presentation's combined body.
    prefix=text.createTextCursorByRange(actual.getStart());prefix.gotoStart(True);start=len(prefix.String.encode('utf-16-le'))//2
    end=start+len(content.encode('utf-16-le'))//2
    if not comparable and end>48000:fail('NATIVE_SELECTION_UNSUPPORTED','当前原生对象文字范围超过可验证的字符限制。')
    locator={'blockId':identity,'from':start,'to':end}
    if comparable:
        anchor=text.createTextCursorByRange(actual.getStart());anchor.gotoRange(actual.getEnd(),True)
        cache[:]=[item for item in cache if item['revision']==revision][-63:];cache.append({'revision':revision,'container':identity,'range':anchor,'locator':locator})
    return dict(locator)
def selection(session,view):
    controller=view['controller'];result={'kind':'none','text':''}
    try:
        selected=controller.getSelection()
        if session['format']=='xlsx':
            address=selected.getRangeAddress();sheet=controller.getActiveSheet();area=(address.EndColumn-address.StartColumn+1)*(address.EndRow-address.StartRow+1);text='\n'.join('\t'.join(str(v) for v in row) for row in selected.getDataArray())[:48000] if area<=2000 else '';result={'kind':'cells','text':text,'sheetIndex':address.Sheet,'sheetName':sheet.Name,'range':range_name(address)}
        elif session['format']=='docx':
            count=selected.getCount()
            if count>64:fail('NATIVE_SELECTION_UNSUPPORTED','原生文字范围数量超出可验证范围。')
            actuals=[selected.getByIndex(i) for i in range(count)] or [controller.getViewCursor()];pieces=[actual.getString() for actual in actuals];content='\n'.join(pieces);cursor=controller.getViewCursor()
            result={'kind':'text' if content else 'none','text':content[:48000],'pageIndex':max(0,cursor.getPage()-1),'locator':{'kind':'native-text','pageIndex':max(0,cursor.getPage()-1),'quote':content[:240]}}
            try:
                ranges=[native_range_locator(session,view,actual,piece) for actual,piece in zip(actuals,pieces)]
                result['locator'].update(ranges[0])
                if len(ranges)>1:result['locator']['blockId']='native-ranges:'+hashlib.sha256(json.dumps(ranges,sort_keys=True).encode()).hexdigest()
                if getattr(cursor,'Cell',None) is not None:result['locator']['cell']=cursor.Cell.CellName
            except:result['identityUnavailable']=True
        else:
            pages=session['doc'].getDrawPages();page=controller.getCurrentPage();index=next((i for i in range(pages.getCount()) if pages.getByIndex(i)==page),0)
            if selected is not None and hasattr(selected,'getCount'):
                # Impress getSelection falls back to marked shapes when its
                # active Outliner has only a caret (e.g. after text Undo).
                # That fallback never proves an object or full-text selection.
                if view.get('nativeEditing') or view.get('caretVisible'):return {'kind':'none','text':'','slideIndex':index}
                objects=[selected.getByIndex(i) for i in range(min(selected.getCount(),100))];result={'kind':'objects' if objects else 'none','text':'\n'.join(getattr(v,'String','') for v in objects)[:48000],'slideIndex':index,'objectNames':[getattr(v,'Name','') for v in objects]}
                try:
                    if selected.getCount()>100:fail('NATIVE_SELECTION_UNSUPPORTED','所选对象数量超出可验证范围。')
                    if objects:result['locator']={'kind':'native-shapes','slideId':str(index),'blockId':hashlib.sha256(json.dumps([native_shape_identity(session,value) for value in objects]).encode()).hexdigest()}
                except:result['identityUnavailable']=True
            elif selected is not None and hasattr(selected,'getString'):
                content=selected.getString();result={'kind':'text' if content else 'none','text':content[:48000],'slideIndex':index,'locator':{'kind':'native-text','slideId':str(index),'quote':content[:240]}}
                try:result['locator'].update(native_range_locator(session,view,selected,content))
                except:result['identityUnavailable']=True
            else:result['slideIndex']=index
    except:
        if session['format'] in ['docx','pptx']:result['identityUnavailable']=True
    return result
def undo_state(session):
    try:
        manager=session['doc'].getUndoManager();titles=list(manager.getAllUndoActionTitles());redo=manager.isRedoPossible();title=manager.getCurrentUndoActionTitle() if titles else None
        token=hashlib.sha256(json.dumps([session['engineRevision'],titles],ensure_ascii=False).encode()).hexdigest()
        return {'canUndo':manager.isUndoPossible(),'canRedo':redo,'title':title,'count':len(titles),'token':token}
    except:return {'canUndo':False,'canRedo':False,'count':0,'token':''}
def body_accessibility(view):
    visible,truncated,pending,rect,ready=native_accessibility(view)
    view['accessibilityAvailable']=ready
    return visible,truncated,pending,rect
def state(session,view):
    hwnd=view['hwnd'];density=view_scale(view);client=rectangle(hwnd,True);screen=rectangle(hwnd);pid=W.DWORD();user32.GetWindowThreadProcessId(hwnd,C.byref(pid));selected=selection(session,view)
    update_selection_epoch(session,view,selected)
    if view.get('actualBounds')!=screen:view['layoutRevision']+=1;view['actualBounds']=screen;view.pop('captureCache',None);view.pop('accessibilityCache',None)
    try:
        try:settings=view['controller'].getViewSettings()
        except:settings=view['controller']
        zoom=float(settings.ZoomValue)/100.
    except:zoom=None
    if zoom is not None and view.get('zoom') is not None and zoom!=view['zoom']:view['layoutRevision']+=1;view.pop('captureCache',None);view.pop('accessibilityCache',None)
    view['zoom']=zoom
    cache_key=(session['engineRevision'],view['selectionEpoch'],view['layoutRevision']);cached=view.get('accessibilityCache')
    if cached and cached['key']==cache_key and time.monotonic()-cached['at']<.2:visibleText,truncated,pending,selected_rect=cached['data']
    else:
        visibleText,truncated,pending,selected_rect=body_accessibility(view);view['accessibilityCache']={'key':cache_key,'at':time.monotonic(),'data':(visibleText,truncated,pending,selected_rect)}
    visible_signature=view.get('accessibilityViewportSignature');previous_signature=view.get('reportedViewportSignature')
    if visible_signature is not None:
        view['reportedViewportSignature']=visible_signature
        if previous_signature is not None and previous_signature!=visible_signature:
            view['layoutRevision']+=1;view.pop('captureCache',None)
    pending=pending or own_ime_pending(view)
    if selected_rect and selected['kind']!='none':selected['rect']=selected_rect
    sidebar=sidebar_state(view);observe_requested_deck(view,sidebar)
    viewport={'width':client['width']/density,'height':client['height']/density,'deviceScaleFactor':density,'bounds':view['bounds'],'screenBounds':screen,'layoutRevision':view['layoutRevision'],'scrollX':0,'scrollY':0}
    if session['format']=='xlsx':
        try:viewport['visibleRange']=range_name(view['controller'].getVisibleRange())
        except:pass
    urls=[]
    try:urls=[e.ResourceURL for e in view['frame'].LayoutManager.getElements() if view['frame'].LayoutManager.isVisible() and view['frame'].LayoutManager.isElementVisible(e.ResourceURL)]
    except:pass
    supported=['office.formatText','office.setTextStyle','word.setBlock','word.setParagraphFormat','word.insertParagraph','word.deleteParagraph','word.insertTable','word.setPageLayout'] if session['format']=='docx' else ['slides.setText','slides.setShapeBounds','slides.setShapeStyle','slides.addTextShape','slides.deleteShape','slides.addSlide','slides.deleteSlide','slides.duplicateSlide','slides.setBackground','slides.setNotes','office.formatText','office.setTextStyle'] if session['format']=='pptx' else ['sheets.setCell','sheets.setRangeValues','sheets.setCellFormat','sheets.setRangeFormat','sheets.mergeCells','sheets.unmergeCells','sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns','sheets.setColumnWidth','sheets.setRowHeight','sheets.addWorksheet','sheets.renameWorksheet','sheets.deleteWorksheet','sheets.setFreeze','sheets.setAutoFilter','sheets.sortRange']
    native_dirty=refresh_content_dirtiness(session)
    return dict(sessionId=session['sessionId'],documentId=session['documentId'],viewId=view['viewId'],format=session['format'],revision=session['revision'],status='ready',supportedOperations=supported,selectionActions=selection_actions(session,view,selected),engineEpoch=epoch,engineRevision=session['engineRevision'],selectionEpoch=view['selectionEpoch'],actor=view.get('actor',session.get('actor','human')),dirty=native_dirty,unsavedContentChanges=bool(session['unsavedContentChanges']),nativeHwnd=str(hwnd),nativePid=pid.value,visible=view['visible'] and bool(user32.IsWindowVisible(hwnd)),nativeGeometry=native_geometry(view,client,screen),focused=int(user32.GetForegroundWindow() or 0)==hwnd,pendingInput=pending,viewport=viewport,zoom=zoom,selection=selected,visibleText=visibleText,visibleTextReady=bool(view.get('accessibilityAvailable')),visibleTextSource='actual-a11y' if view.get('accessibilityAvailable') else 'unavailable',visibleTextTruncated=truncated,undo=undo_state(session),nativeUi={'menus':bool(user32.GetMenu(hwnd)) or any('/menubar/' in v for v in urls),'toolbars':any('/toolbar/' in v for v in urls),'statusbar':any('/statusbar/' in v for v in urls),**sidebar},warnings=['MACROS_DISABLED'] if view.get('macroNoticeInMetadata') else [])

def sheet_by_name(session,name):
    if session['format']!='xlsx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是工作簿。')
    sheets=session['doc'].getSheets()
    if not sheets.hasByName(name):fail('INVALID_TARGET','工作表名称已变化。')
    return sheets.getByName(name)
def checked_range(sheet,name):
    if not re.fullmatch(r'[A-Z]{1,3}[1-9][0-9]{0,6}(?::[A-Z]{1,3}[1-9][0-9]{0,6})?',name):fail('INVALID_TARGET','单元格范围无效。')
    value=sheet.getCellRangeByName(name);address=value.getRangeAddress()
    if (address.EndColumn-address.StartColumn+1)*(address.EndRow-address.StartRow+1)>10000:fail('NATIVE_QUERY_LIMIT','一次读取最多一万个单元格。')
    return value

def excel_formula_parser(session):
    parser=session.get('excelFormulaParser')
    if parser is not None:return parser
    try:
        parser=session['doc'].createInstance('com.sun.star.sheet.FormulaParser')
        mapper=session['doc'].createInstance('com.sun.star.sheet.FormulaOpCodeMapper')
        parser.CompileEnglish=True
        parser.FormulaConvention=constant('com.sun.star.sheet.AddressConvention.XL_A1',1)
        # Some bundled implementations omit this documented property. The native
        # XL_ENGLISH OpCodeMap below also defines the Excel comma separator.
        if parser.getPropertySetInfo().hasPropertyByName('ParameterSeparator'):parser.ParameterSeparator=','
        parser.OpCodeMap=mapper.getAvailableMappings(constant('com.sun.star.sheet.FormulaLanguage.XL_ENGLISH',4),constant('com.sun.star.sheet.FormulaMapGroup.ALL_EXCEPT_SPECIAL',0x7fffffff))
    except:fail('NATIVE_FORMULA_UNAVAILABLE','原生 Excel 公式解析器不可用，没有降级改写公式字符。')
    session['excelFormulaParser']=parser
    return parser

def set_excel_formula(session,cell,text):
    if not isinstance(text,str) or not text or len(text)>100000:fail('INVALID_NATIVE_FORMULA','公式内容无效。')
    formula=text if text.startswith('=') else '='+text
    try:
        tokens=excel_formula_parser(session).parseFormula(formula,cell.getCellAddress())
        if not tokens:fail('INVALID_NATIVE_FORMULA','公式没有有效的原生 token。')
        cell.setTokens(tokens)
    except RuntimeError:raise
    except:fail('INVALID_NATIVE_FORMULA','原生 Excel 公式解析或写入失败。')

def set_cell_content(session,cell,content):
    if content.startswith('=') and len(content)>1:set_excel_formula(session,cell,content)
    else:cell.setFormula(content) # Preserve native interpretation of non-formula input.

def excel_cell_formula(session,cell):
    if cell.getType().value!='FORMULA':return cell.getFormula()
    try:
        value=excel_formula_parser(session).printFormula(cell.getTokens(),cell.getCellAddress())
        return value if value.startswith('=') else '='+value
    except:fail('NATIVE_FORMULA_READ_FAILED','原生公式无法按 Excel 语法读取。')

def query_cell_range(session,cells):
    address=cells.getRangeAddress();formulas=[];errors=[];kinds=[];logical=[];values=[list(row) for row in cells.getDataArray()];formats={}
    for row in range(address.EndRow-address.StartRow+1):
        formula_row=[];error_row=[];kind_row=[];logical_row=[]
        for column in range(address.EndColumn-address.StartColumn+1):
            cell=cells.getCellByPosition(column,row);formula_row.append(excel_cell_formula(session,cell));error_row.append(int(cell.getError()))
            kind=cell.getType().value
            numeric=kind=='VALUE';result_type=None
            if kind=='FORMULA':
                try:result_type=cell.getPropertyValue('FormulaResultType').value;numeric=result_type=='VALUE'
                except:pass
            if numeric:
                key=int(cell.NumberFormat)
                if key not in formats:formats[key]=int(session['doc'].getNumberFormats().getByKey(key).Type)
                is_logical=bool(formats[key]&constant('com.sun.star.util.NumberFormat.LOGICAL',1024))
            else:is_logical=None if kind=='FORMULA' and result_type is None else False
            if cell.getError():is_logical=False
            if is_logical and cell.getValue() in [0.,1.]:values[row][column]=bool(cell.getValue())
            kind_row.append('formula' if kind=='FORMULA' else 'logical' if is_logical else {'EMPTY':'empty','VALUE':'number','TEXT':'text'}.get(kind,'unknown'))
            logical_row.append(is_logical)
        formulas.append(formula_row);errors.append(error_row);kinds.append(kind_row);logical.append(logical_row)
    # Calc ISLOGICAL(reference) checks numeric native content plus LOGICAL
    # number format. FormulaResultType keeps text/error formulas from becoming
    # booleans. Noncanonical numeric values (e.g. 42 with BOOLEAN) stay intact.
    return {'values':values,'formulas':formulas,'errors':errors,'kinds':kinds,'logical':logical,'logicalCoverage':'native-number-format'}

def query(session,view,target):
    doc=session['doc'];kind=target['kind'];controller=view['controller']
    if kind=='style':
        selected=selection(session,view);update_selection_epoch(session,view,selected)
        if target['target'] in ['text','paragraph','shape'] and selected.get('identityUnavailable'):return {'targetKind':target['target'],'fields':{name:{'value':None,'state':'unsupported','available':False,'reason':'当前原生目标没有可验证的范围身份。'} for name in STYLE_FIELDS[target['target']]}}
        return inspect_native_style(session,view,target['target'])
    if kind=='selection':return selection(session,view)
    if kind=='document':
        result={'format':session['format'],'title':getattr(doc,'Title','')}
        if session['format']=='docx':result.update(text=doc.Text.String,pageCount=getattr(controller,'PageCount',None))
        elif session['format']=='xlsx':result['sheetCount']=doc.getSheets().getCount()
        else:result['slideCount']=doc.getDrawPages().getCount()
        return result
    if kind=='sheets':
        if session['format']!='xlsx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是工作簿。')
        sheets=doc.getSheets();active=controller.getActiveSheet();items=[]
        for index in range(sheets.getCount()):
            sheet=sheets.getByIndex(index);cursor=sheet.createCursor();cursor.gotoEndOfUsedArea(False);area=cursor.getRangeAddress();items.append({'index':index,'name':sheet.Name,'visible':sheet.IsVisible,'rowCount':area.EndRow+1,'columnCount':area.EndColumn+1})
        return {'sheets':items,'activeIndex':next((i for i in range(sheets.getCount()) if sheets.getByIndex(i)==active),0)}
    if kind=='cell-range':
        cells=checked_range(sheet_by_name(session,target['sheetName']),target['range']);return {'sheetName':target['sheetName'],'range':target['range'],**query_cell_range(session,cells)}
    if kind=='slide-thumbnails':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        indices=target.get('indices');source=slide_thumbnail_source(session)
        if not session.get('slideThumbnailHistoryVerified'):fail('NATIVE_QUERY_UNSUPPORTED','此后端无法验证可复用的缩略图来源，请使用完整幻灯片查询。')
        if not isinstance(indices,list) or not 1<=len(indices)<=3 or any(type(index) is not int or not 0<=index<10000 for index in indices) or len(set(indices))!=len(indices):fail('INVALID_NATIVE_QUERY','请提供1至3个不重复的0-based幻灯片索引。')
        if not isinstance(target.get('source'),dict) or target['source']!=source:fail('STALE_NATIVE_THUMBNAIL','幻灯片来源已变化，请重新读取页面列表。')
        if slide_thumbnail_pending(session,view):fail('NATIVE_PENDING_INPUT','请先完成此文档各视图中的输入，再生成缩略图。')
        pages=doc.getDrawPages()
        if any(index>=pages.getCount() for index in indices):fail('INVALID_TARGET','目标幻灯片不可用。')
        items=[]
        for index in indices:
            thumbnail=slide_thumbnail(session,pages.getByIndex(index),index,source)
            if not thumbnail:
                if slide_thumbnail_pending(session,view):fail('NATIVE_PENDING_INPUT','生成缩略图期间此文档仍有未完成输入，请稍后重试。')
                if source!=slide_thumbnail_source(session):fail('STALE_NATIVE_THUMBNAIL','生成缩略图期间幻灯片来源已变化，请重新读取页面列表。')
                fail('NATIVE_THUMBNAIL_UNAVAILABLE','原生引擎未能生成所请求的幻灯片缩略图。')
            items.append({'index':index,'thumbnail':thumbnail})
        if slide_thumbnail_pending(session,view):fail('NATIVE_PENDING_INPUT','生成缩略图期间此文档仍有未完成输入，请稍后重试。')
        if source!=slide_thumbnail_source(session):fail('STALE_NATIVE_THUMBNAIL','生成缩略图期间幻灯片来源已变化，请重新读取页面列表。')
        return {'source':source,'slides':items}
    if kind=='slides':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        if 'includeThumbnails' in target and type(target['includeThumbnails']) is not bool:fail('INVALID_NATIVE_QUERY','includeThumbnails必须为布尔值。')
        include_thumbnails=target.get('includeThumbnails',True);pages=doc.getDrawPages();active=controller.getCurrentPage();items=[];source=slide_thumbnail_source(session)
        if not include_thumbnails and not session.get('slideThumbnailHistoryVerified'):fail('NATIVE_QUERY_UNSUPPORTED','此后端无法验证可复用的缩略图来源，请使用完整幻灯片查询。')
        for index in range(pages.getCount()):
            page=pages.getByIndex(index);item={'index':index,'name':page.Name,'width':page.Width,'height':page.Height,'text':'\n'.join(getattr(page.getByIndex(i),'String','') for i in range(page.getCount()))}
            if include_thumbnails and index<40:
                thumbnail=slide_thumbnail(session,page,index,source)
                if thumbnail:item['thumbnail']=thumbnail
            items.append(item)
        result={'slides':items,'activeIndex':next((i for i in range(pages.getCount()) if pages.getByIndex(i)==active),0)}
        if not include_thumbnails:
            if source!=slide_thumbnail_source(session):fail('STALE_NATIVE_THUMBNAIL','读取列表期间幻灯片来源已变化，请重新读取。')
            result['thumbnailSource']=source
        return result
    if kind=='shapes':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        pages=doc.getDrawPages();index=target['slideIndex']
        if not isinstance(index,int) or isinstance(index,bool) or index<0 or index>=pages.getCount():fail('INVALID_TARGET','目标幻灯片不可用。')
        page=pages.getByIndex(index);total=page.getCount();objects=[]
        for i in range(min(total,500)):
            shape=page.getByIndex(i);position=shape.getPosition();size=shape.getSize();text=getattr(shape,'String','')
            objects.append({'name':getattr(shape,'Name',''),'type':shape.ShapeType,'text':text[:2000],'textTruncated':len(text)>2000,'bounds':{'x':position.X,'y':position.Y,'width':size.Width,'height':size.Height}})
        return {'slideIndex':index,'total':total,'objects':objects,'truncated':total>500,'unit':'1/100mm'}
    if kind=='shape':
        if session['format']!='pptx':fail('NATIVE_QUERY_UNSUPPORTED','此文档不是演示文稿。')
        page=doc.getDrawPages().getByIndex(target['slideIndex']);found=[page.getByIndex(i) for i in range(page.getCount()) if getattr(page.getByIndex(i),'Name','')==target['name']]
        if len(found)!=1:fail('INVALID_TARGET','对象名称不唯一或已经变化。')
        shape=found[0];return {'name':shape.Name,'text':getattr(shape,'String',''),'type':shape.ShapeType,'bounds':{'x':shape.Position.X,'y':shape.Position.Y,'width':shape.Size.Width,'height':shape.Size.Height},'readOnly':False}
    if kind=='properties':
        value=doc if target['target']=='document' else controller.getSelection()
        try:info=value.getPropertySetInfo();properties=info.getProperties()
        except:fail('NATIVE_QUERY_UNSUPPORTED','此目标没有可查询属性。')
        names=target.get('names');items=[]
        for p in properties:
            if names and p.Name not in names:continue
            try:
                item=value.getPropertyValue(p.Name)
                if isinstance(item,(str,int,float,bool)) or item is None:items.append({'name':p.Name,'type':p.Type.typeName,'value':item,'readOnly':bool(p.Attributes&16)})
            except:pass
        return {'target':target['target'],'properties':items}
    fail('NATIVE_QUERY_UNSUPPORTED','此原生查询尚未接入。')

def slide_thumbnail_pending(session,view):
    return any(not item.get('disposed') and (own_ime_pending(item) or item.get('nativeEditing') or item.get('caretVisible')) for item in session.get('views',{'target':view}).values())

def slide_thumbnail_source(session):
    if globals().get('refresh_pending_surface_geometries'):refresh_pending_surface_geometries(session)
    pages=session['doc'].getDrawPages();geometry=[(page.Name,page.Width,page.Height) for page in (pages.getByIndex(index) for index in range(pages.getCount()))]
    appearance=globals().get('native_appearance')
    digest=lambda value:hashlib.sha256(json.dumps(value,sort_keys=True,separators=(',',':'),ensure_ascii=False).encode('utf-8')).hexdigest()
    # Physical Outliner Undo/Redo can change its real history without an
    # XModifyListener revision. Both native history and actual invalidate
    # generations participate; view-only changes may conservatively miss.
    try:
        manager=session['doc'].getUndoManager();history=[list(manager.getAllUndoActionTitles()),list(manager.getAllRedoActionTitles())];session['slideThumbnailHistoryVerified']=True
    except:
        history=None;session['slideThumbnailHistoryVerified']=False
        session.pop('slideThumbnails',None);session.pop('slideThumbnailBytes',None);session.pop('slideThumbnailSource',None)
    generations=sorted((name,item.get('projectionEventSequence',0),item.get('renderGeneration',0)) for name,item in session.get('views',{}).items() if not item.get('disposed'))
    return {'documentId':session['documentId'],'sessionId':session['sessionId'],'engineEpoch':epoch,'engineRevision':session['engineRevision'],'partGeometryGeneration':session.get('partGeometryGeneration',0),'appearanceKey':digest(appearance),'geometryKey':digest(geometry),'renderKey':digest([history,generations])}

def slide_thumbnail(session,page,index,source=None):
    source=source if source is not None else slide_thumbnail_source(session);scope=json.dumps(source,sort_keys=True,separators=(',',':'))
    if session.get('slideThumbnailSource')!=scope:
        session['slideThumbnails']={};session['slideThumbnailBytes']=0;session['slideThumbnailSource']=scope
    cache=session.setdefault('slideThumbnails',{});key=index
    if session.get('slideThumbnailHistoryVerified') and not slide_thumbnail_pending(session,{}) and key in cache:return cache[key]
    path=ROOT/('thumbnail-'+uuid.uuid4().hex+'.png')
    try:
        export=sm.createInstanceWithContext('com.sun.star.drawing.GraphicExportFilter',ctx);export.setSourceDocument(page)
        options=props({'PixelWidth':320,'PixelHeight':max(1,round(320*page.Height/page.Width)),'Translucent':False})
        if not export.filter(props({'URL':path.as_uri(),'MediaType':'image/png','FilterData':options})):return None
        data=path.read_bytes()
        if not data.startswith(b'\x89PNG\r\n\x1a\n') or len(data)>2*1024*1024:return None
        value='data:image/png;base64,'+base64.b64encode(data).decode()
        if source!=slide_thumbnail_source(session):return None
        # Older backends without a readable history still render freshly, but
        # cannot establish a reusable content receipt from a guessed revision.
        if not session.get('slideThumbnailHistoryVerified') or slide_thumbnail_pending(session,{}):return value
        cache[key]=value;session['slideThumbnailBytes']=session.get('slideThumbnailBytes',0)+len(value)
        while len(cache)>64 or session['slideThumbnailBytes']>8*1024*1024:
            removed=cache.pop(next(iter(cache)));session['slideThumbnailBytes']-=len(removed)
        return value
    except:return None
    finally:
        try:path.unlink()
        except:pass

def model_parts(session):return zipfile.ZipFile(io.BytesIO(session['mappingBytes']))
def native_paragraphs(text):
    result=[];enumeration=text.createEnumeration()
    while enumeration.hasMoreElements():
        item=enumeration.nextElement()
        if item.supportsService('com.sun.star.text.TextTable'):
            names=list(item.getCellNames())
            def key(name):
                match=re.fullmatch(r'([A-Z]+)([0-9]+)',name)
                if not match:return (0,0)
                column=0
                for char in match.group(1):column=column*26+ord(char)-64
                return int(match.group(2)),column
            for name in sorted(names,key=key):result.extend(native_paragraphs(item.getCellByName(name).Text))
        elif item.supportsService('com.sun.star.text.Paragraph'):result.append(item)
    return result
def paragraph(session,block_id):
    match=re.fullmatch(r'paragraph-([0-9]+)',block_id or '')
    if not match:fail('INVALID_TARGET','段落身份无效。')
    values=checked_native_paragraphs(session);index=int(match.group(1))
    if index>=len(values):fail('INVALID_TARGET','段落已变化。')
    return values[index]
def checked_native_paragraphs(session):
    values=native_paragraphs(session['doc'].Text)
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read('word/document.xml'));namespace='{http://schemas.openxmlformats.org/wordprocessingml/2006/main}';paragraphs=root.iter(namespace+'p');expected_text=[''.join(t.text or '' for t in p.iter(namespace+'t')) for p in paragraphs]
    if len(expected_text)!=len(values) or any(value.String!=text for value,text in zip(values,expected_text)):fail('NATIVE_TARGET_UNSUPPORTED','正文和镜像段落结构不一致，未猜测对象位置。')
    return values
def mapped_sheet(session,sheet_id):
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read('xl/workbook.xml'));items=root.findall('{*}sheets/{*}sheet');found=[v for v in items if v.attrib.get('sheetId')==str(sheet_id)]
        if len(found)!=1:fail('INVALID_TARGET','工作表身份已变化。')
        return sheet_by_name(session,found[0].attrib['name'])
def mapped_slide(session,slide_id):
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read('ppt/presentation.xml'));rels=ET.fromstring(archive.read('ppt/_rels/presentation.xml.rels'));targets={v.attrib['Id']:str(pathlib.PurePosixPath('ppt')/v.attrib['Target']).replace('ppt/../','') for v in rels};items=root.findall('{*}sldIdLst/{*}sldId');paths=[targets.get(v.attrib.get('{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id')) for v in items]
        if slide_id not in paths:fail('INVALID_TARGET','幻灯片身份已变化。')
        index=paths.index(slide_id);return session['doc'].getDrawPages().getByIndex(index),index
def mapped_shape(session,slide_id,shape_id):
    page,index=mapped_slide(session,slide_id)
    with model_parts(session) as archive:
        root=ET.fromstring(archive.read(slide_id));found=[v for v in root.findall('.//{*}cNvPr') if v.attrib.get('id')==str(shape_id)]
        if len(found)!=1:fail('INVALID_TARGET','对象身份已变化。')
        name=found[0].attrib.get('name','');shapes=[page.getByIndex(i) for i in range(page.getCount()) if getattr(page.getByIndex(i),'Name','')==name]
        if len(shapes)!=1:fail('INVALID_TARGET','原生对象名称不唯一。')
        return page,shapes[0]
def text_style(target,op):
    for field,property_name in [('fontName','CharFontName'),('fontSize','CharHeight')]:
        if field in op:setattr(target,property_name,op[field])
    if 'bold' in op:target.CharWeight=150. if op['bold'] else 100.
    if 'italic' in op:target.CharPosture=uno.Enum('com.sun.star.awt.FontSlant','ITALIC' if op['italic'] else 'NONE')
    if 'underline' in op:target.CharUnderline=constant('com.sun.star.awt.FontUnderline.SINGLE',1) if op['underline'] else 0
    if 'strike' in op:target.CharStrikeout=constant('com.sun.star.awt.FontStrikeout.SINGLE',1) if op['strike'] else 0
    if 'color' in op:target.CharColor=int(op['color'],16)
    if 'highlight' in op:target.CharBackColor=int(op['highlight'],16)
def move_right(cursor,count,select):
    while count>0:
        amount=min(count,32767)
        if not cursor.goRight(amount,select):fail('INVALID_TARGET','原生文本范围已变化。')
        count-=amount
def utf16_index(text,index):
    total=0
    for i,char in enumerate(text):
        if total==index:return i
        total+=2 if ord(char)>0xffff else 1
        if total>index:fail('INVALID_TARGET','文字范围截断了 Unicode 字符。')
    if total==index:return len(text)
    fail('INVALID_TARGET','文字范围超出正文。')
def execute_operation(session,view,op,args=None):
    doc=session['doc'];kind=op['kind'];point=lambda value:round(value*2540/72)
    if kind.startswith('word.') or kind.startswith('office.'):
        target=paragraph(session,op.get('blockId')) if session['format']=='docx' and 'blockId' in op else mapped_shape(session,op['slideId'],op['blockId'])[1] if session['format']=='pptx' else None
        if kind in ['office.formatText','office.setTextStyle']:
            start=utf16_index(target.String,op['from']);end=utf16_index(target.String,op['to'])
            if target.String[start:end]!=op['expectedText']:fail('REVISION_CONFLICT','目标文字已变化。')
            cursor=target.Text.createTextCursorByRange(target.getStart());move_right(cursor,start,False);move_right(cursor,end-start,True)
            style=op if kind=='office.setTextStyle' else {op['style']:op['enabled']};text_style(cursor,style)
        elif kind=='word.setBlock':target.String=op['text']
        elif kind=='word.setParagraphFormat':
            if 'style' in op:target.ParaStyleName={'Normal':'Standard','Heading1':'Heading 1','Heading2':'Heading 2','Heading3':'Heading 3'}[op['style']]
            if 'alignment' in op:target.ParaAdjust=uno.Enum('com.sun.star.style.ParagraphAdjust',{'left':'LEFT','center':'CENTER','right':'RIGHT','both':'BLOCK'}[op['alignment']])
            for key,name in [('spacingBefore','ParaTopMargin'),('spacingAfter','ParaBottomMargin'),('indentLeft','ParaLeftMargin'),('indentRight','ParaRightMargin'),('indentFirstLine','ParaFirstLineIndent')]:
                if key in op:setattr(target,name,point(op[key]))
            if 'lineSpacing' in op:spacing=uno.createUnoStruct('com.sun.star.style.LineSpacing');spacing.Mode=constant('com.sun.star.style.LineSpacingMode.PROP',0);spacing.Height=round(op['lineSpacing']*100);target.ParaLineSpacing=spacing
        elif kind=='word.insertParagraph':
            target=paragraph(session,op['afterBlockId']);cursor=target.Text.createTextCursorByRange(target.getEnd());target.Text.insertControlCharacter(cursor,constant('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK',0),False);target.Text.insertString(cursor,op['text'],False);cursor.ParaStyleName={'Normal':'Standard','Heading1':'Heading 1','Heading2':'Heading 2','Heading3':'Heading 3'}[op.get('style','Normal')]
        elif kind=='word.deleteParagraph':
            cursor=target.Text.createTextCursorByRange(target.getStart());cursor.gotoRange(target.getEnd(),True);cursor.goRight(1,True);cursor.String=''
        elif kind=='word.insertTable':
            target=paragraph(session,op['afterBlockId']);table=doc.createInstance('com.sun.star.text.TextTable');table.initialize(len(op['rows']),len(op['rows'][0]));cursor=target.Text.createTextCursorByRange(target.getEnd());target.Text.insertControlCharacter(cursor,constant('com.sun.star.text.ControlCharacter.PARAGRAPH_BREAK',0),False);target.Text.insertTextContent(cursor,table,False)
            for r,row in enumerate(op['rows']):
                for c,text in enumerate(row):table.getCellByName(letter(c)+str(r+1)).String=text
        elif kind=='word.setPageLayout':
            if op.get('sectionIndex',0)!=0:fail('NATIVE_OPERATION_UNSUPPORTED','当前原生页设置需要具体页面样式目标。')
            if args and (args.get('background') or args.get('actor','agent')=='agent'):fail('BACKGROUND_EDIT_UNSUPPORTED','后台页面布局必须指定 pageStyleName，不读取人类光标所在页面样式。')
            style=doc.getStyleFamilies().getByName('PageStyles').getByName(view['controller'].getViewCursor().PageStyleName)
            if 'orientation' in op:
                landscape=op['orientation']=='landscape';style.IsLandscape=landscape
                if (style.Width>style.Height)!=landscape:width=style.Width;style.Width=style.Height;style.Height=width
            for side,value in op.get('margins',{}).items():setattr(style,side.capitalize()+'Margin',point(value))
        else:fail('NATIVE_OPERATION_UNSUPPORTED','此文字操作尚未映射到原生引擎。')
    elif kind.startswith('sheets.'):
        sheets=doc.getSheets();sheet=mapped_sheet(session,op['sheetId']) if 'sheetId' in op else None
        if kind=='sheets.setCell':
            cell=checked_range(sheet,op['address'])
            if op.get('formula') is not None:set_excel_formula(session,cell,op['formula'])
            elif op.get('valueType')=='number':cell.Value=float(op['value'])
            elif op.get('valueType')=='boolean':cell.Value=1. if op['value'].lower()=='true' else 0.;cell.NumberFormat=99
            else:cell.String=op['value']
        elif kind=='sheets.setRangeValues':
            start=checked_range(sheet,op['start']).getRangeAddress()
            for r,row in enumerate(op['rows']):
                for c,text in enumerate(row):
                    cell=sheet.getCellByPosition(start.StartColumn+c,start.StartRow+r)
                    if text.startswith('=') and len(text)>1:set_excel_formula(session,cell,text)
                    else:cell.String=text
        elif kind in ['sheets.setCellFormat','sheets.setRangeFormat']:
            target=checked_range(sheet,op.get('address',op.get('range')));text_style(target,op)
            if 'fill' in op:target.CellBackColor=int(op['fill'],16)
            if 'wrap' in op:target.IsTextWrapped=op['wrap']
            if 'horizontal' in op:target.HoriJustify=uno.Enum('com.sun.star.table.CellHoriJustify',op['horizontal'].upper())
            if 'vertical' in op:target.VertJustify=uno.Enum('com.sun.star.table.CellVertJustify',{'top':'TOP','middle':'CENTER','bottom':'BOTTOM'}[op['vertical']])
            if 'numberFormat' in op:
                locale=target.CharLocale;key=doc.NumberFormats.queryKey(op['numberFormat'],locale,True);target.NumberFormat=key if key>=0 else doc.NumberFormats.addNew(op['numberFormat'],locale)
            if 'borders' in op:
                border=uno.createUnoStruct('com.sun.star.table.TableBorder2');line=uno.createUnoStruct('com.sun.star.table.BorderLine2');line.Color=int(op.get('borderColor','808080'),16);line.LineWidth=point(1.5 if op.get('borderStyle')=='medium' else .75);line.LineStyle=constant('com.sun.star.table.BorderLineStyle.DASHED',3) if op.get('borderStyle')=='dashed' else constant('com.sun.star.table.BorderLineStyle.SOLID',0)
                for side in ['Top','Bottom','Left','Right','Horizontal','Vertical']:
                    enabled=op['borders']=='all' or op['borders']=='outline' and side in ['Top','Bottom','Left','Right'] or op['borders']=='bottom' and side=='Bottom';setattr(border,side+'Line',line if enabled else uno.createUnoStruct('com.sun.star.table.BorderLine2'));setattr(border,'Is'+side+'LineValid',True)
                target.TableBorder2=border
        elif kind in ['sheets.mergeCells','sheets.unmergeCells']:
            target=checked_range(sheet,op['range'])
            if kind=='sheets.mergeCells':
                values=target.getDataArray()
                if any(value!='' for r,row in enumerate(values) for c,value in enumerate(row) if r or c):fail('MERGE_WOULD_DISCARD_DATA','合并区域包含需要保留的非主单元格内容。')
            target.merge(kind=='sheets.mergeCells')
        elif kind in ['sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns']:
            collection=sheet.getRows() if 'Rows' in kind else sheet.getColumns();method=collection.insertByIndex if '.insert' in kind else collection.removeByIndex;method(op['index']-1,op.get('count',1))
        elif kind=='sheets.setColumnWidth':sheet.getColumns().getByIndex(op['index']-1).Width=round(op['width']*210)
        elif kind=='sheets.setRowHeight':sheet.getRows().getByIndex(op['index']-1).Height=point(op['height'])
        elif kind=='sheets.addWorksheet':sheets.insertNewByName(op['name'],sheets.getCount())
        elif kind=='sheets.renameWorksheet':sheet.Name=op['name']
        elif kind=='sheets.deleteWorksheet':
            if sheets.getCount()<=1:fail('INVALID_TARGET','工作簿必须保留至少一个工作表。')
            sheets.removeByName(sheet.Name)
        elif kind=='sheets.setFreeze':
            if args and (args.get('background') or args.get('actor','agent')=='agent'):fail('BACKGROUND_EDIT_UNSUPPORTED','冻结窗格依赖视图控制器，后台执行不会切换人类工作表。')
            view['controller'].setActiveSheet(sheet);view['controller'].freezeAtPosition(op['columns'],op['rows'])
        elif kind=='sheets.setAutoFilter':
            if not op.get('range'):fail('INVALID_TARGET','原生筛选需要明确区域。')
            target=checked_range(sheet,op['range']);name='AgentViewerFilter'+str(target.getRangeAddress().Sheet);ranges=doc.DatabaseRanges
            if ranges.hasByName(name):ranges.removeByName(name)
            if op['enabled']:ranges.addNewByName(name,target.getRangeAddress());ranges.getByName(name).AutoFilter=True
        elif kind=='sheets.sortRange':
            target=checked_range(sheet,op['range']);address=target.getRangeAddress();field=uno.createUnoStruct('com.sun.star.util.SortField');field.Field=op['column']-1-address.StartColumn;field.SortAscending=op['direction']=='asc';target.sort(props({'SortFields':(field,),'ContainsHeader':op['header'],'IsSortColumns':False}))
        else:fail('NATIVE_OPERATION_UNSUPPORTED','此工作表操作尚未映射到原生引擎。')
    elif kind.startswith('slides.'):
        pages=doc.getDrawPages();page,index=mapped_slide(session,op['slideId']) if 'slideId' in op else (None,-1)
        if kind=='slides.setText':ppt_set_shape_text(session,view,op,args or {})
        elif kind=='slides.setShapeStyle':apply_mapped_shape_style(session,view,op,args or {})
        elif kind=='slides.setShapeBounds':
            shape=mapped_shape(session,op['slideId'],op['shapeId'])[1]
            shape.Position=uno.createUnoStruct('com.sun.star.awt.Point',round(op['x']*page.Width),round(op['y']*page.Height));shape.Size=uno.createUnoStruct('com.sun.star.awt.Size',round(op['width']*page.Width),round(op['height']*page.Height))
        elif kind=='slides.addTextShape':
            shape=doc.createInstance('com.sun.star.drawing.TextShape');shape.Position=uno.createUnoStruct('com.sun.star.awt.Point',round(op['x']*page.Width),round(op['y']*page.Height));shape.Size=uno.createUnoStruct('com.sun.star.awt.Size',round(op['width']*page.Width),round(op['height']*page.Height));page.add(shape);shape.String=op['text']
        elif kind=='slides.deleteShape':page.remove(mapped_shape(session,op['slideId'],op['shapeId'])[1])
        elif kind=='slides.addSlide':
            after=mapped_slide(session,op['afterSlideId'])[1] if op.get('afterSlideId') else pages.getCount()-1;new=pages.insertNewByIndex(after)
            if op.get('title'):
                shape=doc.createInstance('com.sun.star.drawing.TextShape');shape.Position=uno.createUnoStruct('com.sun.star.awt.Point',1000,1000);shape.Size=uno.createUnoStruct('com.sun.star.awt.Size',new.Width-2000,3000);new.add(shape);shape.String=op['title']
        elif kind=='slides.deleteSlide':
            if pages.getCount()<=1:fail('INVALID_TARGET','演示文稿必须保留至少一页。')
            pages.remove(page)
        elif kind=='slides.duplicateSlide':doc.duplicate(page)
        elif kind=='slides.moveSlide':authoring_move_slide(session,view,index,op['index'])
        elif kind=='slides.setBackground':background=doc.createInstance('com.sun.star.drawing.Background');background.FillStyle=uno.Enum('com.sun.star.drawing.FillStyle','SOLID');background.FillColor=int(op['color'],16);page.Background=background
        elif kind=='slides.setNotes':
            notes=page.getNotesPage();found=[notes.getByIndex(i) for i in range(notes.getCount()) if notes.getByIndex(i).ShapeType=='com.sun.star.presentation.NotesShape']
            if len(found)!=1:fail('INVALID_TARGET','备注正文目标不唯一。')
            found[0].String=op['text']
        else:fail('NATIVE_OPERATION_UNSUPPORTED','此幻灯片操作需要原生命令参数。')
    else:fail('NATIVE_OPERATION_UNSUPPORTED','此操作不属于原生 Office。')

FILTERS={'docx':'Office Open XML Text','pptx':'Impress MS PowerPoint 2007 XML','xlsx':'Calc MS Excel 2007 XML','odt':'writer8','ods':'calc8','odp':'impress8'}
def snapshot_diagnostic(session,attempt,format,before,after,dirty_before,dirty_after,undo_before,undo_after):
    # Undo titles can contain user-entered content. Diagnostics retain hashes,
    # counts and state flags only, never titles, paths or document text.
    def version(revision,dirty,undo):return {'revision':revision,'dirty':bool(dirty),'undoToken':undo.get('token',''),'undoCount':undo.get('count',0),'canUndo':bool(undo.get('canUndo')),'canRedo':bool(undo.get('canRedo'))}
    return {'type':'diagnostic','code':'NATIVE_SNAPSHOT_UNSTABLE','sessionId':session.get('sessionId'),'format':session['format'],'exportFormat':format,'attempt':attempt+1,'before':version(before,dirty_before,undo_before),'after':version(after,dirty_after,undo_after),'changed':{'revision':before!=after,'dirty':dirty_before!=dirty_after,'undo':undo_before!=undo_after,'undoTitle':undo_before.get('title')!=undo_after.get('title')}}

def reconcile_clone_shape_colors(session,clone):
    source_pages=session['doc'].getDrawPages();clone_pages=clone.getDrawPages()
    if source_pages.getCount()!=clone_pages.getCount():fail('NATIVE_EXPORT_FAILED','隔离导出副本的页面结构不一致。')
    for page_index in range(source_pages.getCount()):
        source_page=source_pages.getByIndex(page_index);clone_page=clone_pages.getByIndex(page_index)
        if source_page.getCount()!=clone_page.getCount():fail('NATIVE_EXPORT_FAILED','隔离导出副本的对象结构不一致。')
        for index in range(source_page.getCount()):
            source=source_page.getByIndex(index);target=clone_page.getByIndex(index)
            if source.ShapeType!=target.ShapeType or getattr(source,'Name','')!=getattr(target,'Name','') or getattr(source,'String','')!=getattr(target,'String',''):fail('NATIVE_EXPORT_FAILED','隔离导出副本的实际对象身份不一致。')
            source_info=source.getPropertySetInfo();target_info=target.getPropertySetInfo();copied=False
            for color,complex_name in [('FillColor','FillComplexColor'),('LineColor','LineComplexColor')]:
                if not source_info.hasPropertyByName(color) or not source_info.hasPropertyByName(complex_name):continue
                if not target_info.hasPropertyByName(color) or not target_info.hasPropertyByName(complex_name):fail('NATIVE_EXPORT_FAILED','隔离导出副本缺少原生颜色属性。')
                rgb=source.getPropertyValue(color);complex_value=source.getPropertyValue(complex_name)
                # ODF may omit an Unused/Unknown complex color and inherit a
                # parent's theme in the temporary clone. Copy the immutable
                # native value only onto that verified clone; never the source.
                # The public interface cannot enumerate hidden transforms;
                # always copy the complete immutable native carrier. A theme
                # setter may resolve its cached RGB, so restore RGB last.
                target.setPropertyValue(complex_name,uno.Any('com.sun.star.util.XComplexColor',complex_value));target.setPropertyValue(color,uno.Any('long',rgb));copied=True
                actual=target.getPropertyValue(complex_name)
                if rgb!=target.getPropertyValue(color) or (complex_value.getType(),complex_value.getThemeColorType())!=(actual.getType(),actual.getThemeColorType()):fail('NATIVE_EXPORT_FAILED','隔离导出副本的颜色恢复未通过验证。')
            if copied:
                if source_info.hasPropertyByName('InteropGrabBag'):
                    if not target_info.hasPropertyByName('InteropGrabBag'):fail('NATIVE_EXPORT_FAILED','隔离导出副本缺少颜色互操作属性。')
                    bag=source.getPropertyValue('InteropGrabBag');target.setPropertyValue('InteropGrabBag',uno.Any('[]com.sun.star.beans.PropertyValue',bag))
                    if style_value_key(bag)!=style_value_key(target.getPropertyValue('InteropGrabBag')):fail('NATIVE_EXPORT_FAILED','隔离导出副本的互操作属性恢复未通过验证。')

def store_snapshot_file(session,output,filter_name):
    # PPTX's exporter creates and removes temporary layout slides in the live
    # model. Those implementation details must not become user undo actions.
    # XUndoManager.lock alone does not stop the native Impress exporter's own
    # Sdr undo records. Serialize the live model to ODP, then let a private,
    # hidden read-only clone bear the PPTX export's temporary layout changes.
    # Suspend registered inputs only during the short live-model serialization.
    guarded=filter_name=='Impress MS PowerPoint 2007 XML';windows=[];manager=None;locked=False;intermediate=None;clone=None
    try:
        try:
            if guarded:
                for candidate in session['views'].values():
                    if candidate.get('disposed'):continue
                    window=candidate['frame'].getContainerWindow()
                    if not window.isEnabled():fail('NATIVE_PENDING_INPUT','原生对话框或输入操作尚未结束，没有冻结其内容。')
                    windows.append(window);window.setEnable(False)
                manager=session['doc'].getUndoManager()
                if manager.isLocked():fail('NATIVE_UNDO_BUSY','原生撤销事务尚未结束，没有改变其记录。')
                manager.lock();locked=True;intermediate=ROOT/(str(uuid.uuid4())+'.odp')
            serialization_started=time.monotonic()
            # The ODP is read synchronously by our private clone, then deleted.
            # Its disk sync serves no publication/recovery purpose. Keep the
            # thumbnail path: toggling NoThumbnail mutates the pinned model.
            # This descriptor affects only the temporary store; the final
            # file's sync and native undo protection remain intact.
            options={'FilterName':'impress8' if guarded else filter_name,'Overwrite':True}
            if guarded:options.update(NoFileSync=True)
            session['doc'].storeToURL((intermediate or output).as_uri(),props(options))
            if guarded:emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'serialize-intermediate','elapsedMs':round((time.monotonic()-serialization_started)*1000,2)})
        finally:
            try:
                if locked:manager.unlock()
            finally:
                restore_failed=False
                for window in reversed(windows):
                    try:window.setEnable(True)
                    except:restore_failed=True
                if restore_failed:fail('NATIVE_INPUT_RESTORE_FAILED','原生视图输入未恢复，请保留文档并重新打开该视图。')
        if intermediate is not None:
            clone_started=time.monotonic()
            clone=desktop.loadComponentFromURL(intermediate.as_uri(),'_blank',0,props({'Hidden':True,'ReadOnly':True,'FilterName':'impress8','MacroExecutionMode':uno.Any('short',0),'UpdateDocMode':uno.Any('short',0),'InteractionHandler':SafeImportInteraction()}))
            emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'load-readonly-clone','elapsedMs':round((time.monotonic()-clone_started)*1000,2)})
            if clone is None:fail('NATIVE_EXPORT_FAILED','无法创建隔离的只读导出副本。')
            reconcile_started=time.monotonic()
            reconcile_clone_shape_colors(session,clone)
            emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'reconcile-colors','elapsedMs':round((time.monotonic()-reconcile_started)*1000,2)})
            export_started=time.monotonic()
            clone.storeToURL(output.as_uri(),props({'FilterName':filter_name,'Overwrite':True}))
            emit({'type':'diagnostic','code':'NATIVE_SNAPSHOT_STAGE','sessionId':session['sessionId'],'stage':'export-pptx','elapsedMs':round((time.monotonic()-export_started)*1000,2)})
    finally:
        try:
            if clone is not None:clone.close(True)
        finally:
            if intermediate is not None:
                try:intermediate.unlink()
                except FileNotFoundError:pass

def snapshot_input_pending(session,view):return state(session,view)['pendingInput']

def snapshot(session,view,export_format=None,known=None):
    def response(result,data):
        # The host lends its verified mirror, never a second resident cache.
        # Native state, undo and every controller's input barrier are still
        # checked before this branch. Only the wire payload is omitted.
        if not export_format and isinstance(known,dict) and type(known.get('engineRevision')) is int and isinstance(known.get('sha256'),str) and len(known['sha256'])==64 and known.get('engineEpoch')==epoch and known.get('engineRevision')==result.get('engineRevisionAfter')==result['state'].get('engineRevision') and known.get('sha256')==result.get('sha256'):
            return dict(result,unchanged=True)
        return dict(result,bytes=base64.b64encode(data).decode())
    for candidate in session['views'].values():
        if not candidate.get('disposed') and snapshot_input_pending(session,candidate):fail('NATIVE_PENDING_INPUT','此文档的原生视图仍有未完成输入，没有自动提交。')
    cached=session.get('lastSnapshot');current_undo=undo_state(session)
    # An explicit native-format copy may use the same verified immutable bytes,
    # but never a cross-format or legacy cache without a declared format/raw body.
    same_format_copy=export_format==session['format'] and cached and isinstance(cached.get('result'),dict) and cached['result'].get('format')==export_format and isinstance(cached.get('data'),bytes)
    if (export_format is None or same_format_copy) and cached and cached.get('result') and cached['engineRevision']==session['engineRevision'] and cached.get('undoToken')==current_undo.get('token') and cached.get('dirty')==session['doc'].isModified():
        # ZIP metadata is not a content clock. Reuse already-verified same-version bytes,
        # refreshing view state while preserving the all-controller input barrier.
        result=dict(cached['result']);result['state']=state(session,view);result['dirty']=session['doc'].isModified()
        return response(result,cached['data']) if 'data' in cached else result
    format=export_format or session['format'];filter_name=FILTERS.get(format) or {'docx':'writer_pdf_Export','xlsx':'calc_pdf_Export','pptx':'impress_pdf_Export'}.get(session['format']) if format=='pdf' else FILTERS.get(format)
    if not filter_name:fail('NATIVE_EXPORT_UNSUPPORTED','此导出格式尚未接入。')
    family={'docx':{'docx','odt','pdf'},'xlsx':{'xlsx','ods','pdf'},'pptx':{'pptx','odp','pdf'}}
    if format not in family[session['format']]:fail('NATIVE_EXPORT_UNSUPPORTED','此格式不属于当前文档类别。')
    for attempt in range(3):
        before=session['engineRevision'];undo_before=undo_state(session);dirty=session['doc'].isModified();output=ROOT/(str(uuid.uuid4())+'.'+format)
        try:
            session['exporting']=True;store_snapshot_file(session,output,filter_name);data=output.read_bytes()
        finally:
            session['exporting']=False
            try:output.unlink()
            except:pass
        after=session['engineRevision'];undo_after=undo_state(session);dirty_after=session['doc'].isModified()
        if before==after and undo_before==undo_after and dirty_after==dirty:
            digest=hashlib.sha256(data).hexdigest()
            result={'sha256':digest,'format':format,'engineRevisionBefore':before,'engineRevisionAfter':after,'stable':True,'dirty':dirty,'undoToken':undo_after.get('token'),'state':state(session,view)}
            if not export_format:session['lastSnapshot']={'engineRevision':after,'hash':digest,'undoToken':result['undoToken'],'dirty':dirty,'result':result,'data':data};session['mappingBytes']=data
            return response(result,data)
        emit(snapshot_diagnostic(session,attempt,format,before,after,dirty,dirty_after,undo_before,undo_after))
    fail('SNAPSHOT_BUSY','原生文档仍在修改，未发布混合版本快照。')

def acknowledge_saved(session,args):
    refresh_content_dirtiness(session)
    saved=session.get('lastSnapshot');before=session['engineRevision'];before_undo=undo_state(session)
    if not (args.get('engineEpoch')==epoch and saved and saved['engineRevision']==before==args.get('engineRevision') and saved['hash']==args.get('hash') and saved.get('undoToken')==before_undo.get('token')):return False
    acknowledgement={'engineRevision':before,'undo':before_undo};session['acknowledgingSave']=acknowledgement;failed=False
    try:session['doc'].setModified(False)
    except:failed=True
    finally:
        if session.get('acknowledgingSave') is acknowledgement:session.pop('acknowledgingSave',None)
    if failed or session['engineRevision']!=before or undo_state(session)!=before_undo or session['doc'].isModified():
        session['unsavedContentChanges']=True
        session.pop('lastSnapshot',None)
        # A concurrent edit must not be cleared by the preceding status reset.
        if not session['doc'].isModified():session['doc'].setModified(True)
        return False
    session['unsavedContentChanges']=False;saved['dirty']=False
    if saved.get('result'):saved['result']={**saved['result'],'dirty':False,'state':{**saved['result'].get('state',{}),'dirty':False,'unsavedContentChanges':False}}
    return True

class HEADER(C.Structure):
    _fields_=[('size',W.DWORD),('width',C.c_long),('height',C.c_long),('planes',W.WORD),('bits',W.WORD),('compression',W.DWORD),('image',W.DWORD),('xppm',C.c_long),('yppm',C.c_long),('used',W.DWORD),('important',W.DWORD)]
class INFO(C.Structure):_fields_=[('header',HEADER),('colors',W.DWORD*3)]
sig(gdi32,'CreateDIBSection',W.HBITMAP,[W.HDC,C.POINTER(INFO),W.UINT,C.POINTER(C.c_void_p),W.HANDLE,W.DWORD])
def capture(session,view,crop):
    if not native_geometry(view):fail('NATIVE_GEOMETRY_UNAVAILABLE','原生区域与阅读器布局尚未一致。')
    client=rectangle(view['hwnd'],True);width,height=client['width'],client['height'];density=view_scale(view);crop=crop or {'x':0,'y':0,'width':width/density,'height':height/density}
    x=max(0,int(crop['x']*density));y=max(0,int(crop['y']*density));right=min(width,int((crop['x']+crop['width'])*density+.999));bottom=min(height,int((crop['y']+crop['height'])*density+.999))
    if right<=x or bottom<=y:fail('INVALID_CAPTURE_RECT','截图区域不在原生编辑器内。')
    cache_key=(width,height,density,session['engineRevision'],view['selectionEpoch'],view['layoutRevision']);cached=view.get('captureCache')
    if cached and cached['key']==cache_key and time.monotonic()-cached['at']<=.06:raw=cached['raw']
    else:
        dc=user32.GetDC(view['hwnd']);memory=gdi32.CreateCompatibleDC(dc);pointer=C.c_void_p();info=INFO();info.header=HEADER(C.sizeof(HEADER),width,-height,1,32,0,width*height*4,0,0,0,0);bitmap=gdi32.CreateDIBSection(memory,C.byref(info),0,C.byref(pointer),None,0);old=gdi32.SelectObject(memory,bitmap)
        try:
            if not bitmap or not pointer or not user32.PrintWindow(view['hwnd'],memory,2):fail('NATIVE_CAPTURE_FAILED','原生编辑器未提供有效像素。')
            raw=C.string_at(pointer,width*height*4);view['captureCache']={'key':cache_key,'at':time.monotonic(),'raw':raw}
        finally:gdi32.SelectObject(memory,old);gdi32.DeleteObject(bitmap);gdi32.DeleteDC(memory);user32.ReleaseDC(view['hwnd'],dc)
    rows=[];w=right-x;h=bottom-y
    for row in range(y,bottom):
        pixels=raw[(row*width+x)*4:(row*width+right)*4];rgb=bytearray(w*3);rgb[0::3]=pixels[2::4];rgb[1::3]=pixels[1::4];rgb[2::3]=pixels[0::4];rows.append(b'\0'+rgb)
    def chunk(kind,data):return struct.pack('!I',len(data))+kind+data+struct.pack('!I',zlib.crc32(kind+data)&0xffffffff)
    png=b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('!2I5B',w,h,8,2,0,0,0))+chunk(b'IDAT',zlib.compress(b''.join(rows)))+chunk(b'IEND',b'')
    return {'mimeType':'image/png','data':base64.b64encode(png).decode(),'width':w,'height':h,'deviceScaleFactor':density,'rect':{'x':x/density,'y':y/density,'width':w/density,'height':h/density},'engineEpoch':epoch,'engineRevision':session['engineRevision'],'layoutRevision':view['layoutRevision'],'sessionId':session['sessionId'],'capturedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}

def commands(session,view):
    if session.get('commandCatalog') is not None:return session['commandCatalog']
    found={}
    for provider in [view['controller'],view['frame']]:
        try:
            for group in provider.getSupportedCommandGroups():
                for item in provider.getConfigurableDispatchInformation(group):found[item.Command]={'command':item.Command,'group':int(item.GroupId)}
        except:pass
    def parse_items(container):
        for index in range(container.getCount()):
            values={v.Name:v.Value for v in container.getByIndex(index)};command=values.get('CommandURL')
            if command and command.startswith('.uno:'):found.setdefault(command,{'command':command,'label':values.get('Label','')})
            child=values.get('ItemDescriptorContainer')
            if child is not None:parse_items(child)
    try:
        supplier=sm.createInstanceWithContext('com.sun.star.ui.ModuleUIConfigurationManagerSupplier',ctx);module=session['doc'].getIdentifier();config=supplier.getUIConfigurationManager(module);parse_items(config.getSettings('private:resource/menubar/menubar',True))
    except:pass
    result={'commands':list(found.values()),'source':'LibreOffice configurable dispatch/menu configuration','complete':bool(found)}
    if found:session['commandCatalog']=result
    return result
def close_session(session,discard=False):
    if session['doc'].isModified() and not discard:fail('NATIVE_UNSAVED_CHANGES','请先保存或建立恢复快照，再关闭原生编辑器。')
    for view in session['views'].values():close_owned_dialogs(view)
    session['doc'].close(True);sessions.pop(session['sessionId'],None)

def close_owned_dialogs(view):
    frame_pid=W.DWORD();user32.GetWindowThreadProcessId(view['hwnd'],C.byref(frame_pid));closed=[]
    callback_type=C.WINFUNCTYPE(W.BOOL,W.HWND,W.LPARAM)
    @callback_type
    def callback(hwnd,param):
        pid=W.DWORD();user32.GetWindowThreadProcessId(hwnd,C.byref(pid))
        if pid.value!=frame_pid.value or int(hwnd)==view['hwnd'] or not user32.IsWindowVisible(hwnd):return True
        owner=int(user32.GetWindow(hwnd,4) or 0)
        if owner!=view['hwnd']:return True
        title=C.create_unicode_buffer(200)
        if user32.GetWindowTextW(hwnd,title,len(title)) and title.value:closed.append(int(hwnd))
        return True
    user32.EnumWindows(callback,0)
    for hwnd in closed:
        result=C.c_size_t();user32.SendMessageTimeoutW(hwnd,0x10,0,0,2|32,1000,C.byref(result))

class KEYBOARD(C.Structure):_fields_=[('vk',W.WORD),('scan',W.WORD),('flags',W.DWORD),('time',W.DWORD),('extra',C.c_size_t)]
class MOUSE(C.Structure):_fields_=[('dx',C.c_long),('dy',C.c_long),('data',W.DWORD),('flags',W.DWORD),('time',W.DWORD),('extra',C.c_size_t)]
class PAYLOAD(C.Union):_fields_=[('keyboard',KEYBOARD),('mouse',MOUSE)]
class INPUT(C.Structure):_anonymous_=['payload'];_fields_=[('type',W.DWORD),('payload',PAYLOAD)]
def send_keys(items):
    array=(INPUT*len(items))(*items)
    if user32.SendInput(len(items),array,C.sizeof(INPUT))!=len(items):fail('NATIVE_INPUT_FAILED','原生键盘输入未完成。')
def key_event(vk,up=False,scan=0,unicode=False):
    value=INPUT();value.type=1;value.keyboard=KEYBOARD(vk,scan,(2 if up else 0)|(4 if unicode else 0),0,0);return value
def own_input_foreground(view):
    foreground=int(user32.GetForegroundWindow() or 0);value=foreground
    frame_pid=W.DWORD();candidate_pid=W.DWORD();user32.GetWindowThreadProcessId(view['hwnd'],C.byref(frame_pid));user32.GetWindowThreadProcessId(foreground,C.byref(candidate_pid))
    if frame_pid.value!=candidate_pid.value:return False
    for _ in range(12):
        if value==view['hwnd']:return True
        value=int(user32.GetWindow(value,4) or 0)
        if not value:break
    return False
def focus_input(view):
    # An existing modal dialog of this frame is a valid keyboard target; unrelated LO frames are not.
    if own_input_foreground(view):return
    foreground=int(user32.GetForegroundWindow() or 0);candidate=foreground;reader_pid=W.DWORD();foreground_pid=W.DWORD();user32.GetWindowThreadProcessId(view['owner'],C.byref(reader_pid));foreground_thread=user32.GetWindowThreadProcessId(foreground,C.byref(foreground_pid));allowed=False
    if foreground_pid.value==reader_pid.value:
        for _ in range(12):
            if candidate in [view['owner'],view['hwnd']]:allowed=True;break
            candidate=int(user32.GetWindow(candidate,4) or 0)
            if not candidate:break
    if not allowed:fail('NATIVE_INPUT_FOCUS','当前前台不属于目标阅读器，没有向其他应用发送输入。')
    # Join only this Reader's active input queue for the focus handoff, never another app.
    message=W.MSG();user32.PeekMessageW(C.byref(message),None,0,0,0)
    thread=kernel32.GetCurrentThreadId();attached=bool(thread!=foreground_thread and user32.AttachThreadInput(thread,foreground_thread,True))
    try:view['frame'].getComponentWindow().setFocus();user32.SetForegroundWindow(view['hwnd'])
    finally:
        if attached:user32.AttachThreadInput(thread,foreground_thread,False)
    if not own_input_foreground(view):fail('NATIVE_INPUT_FOCUS','原生编辑器未取得输入焦点，没有发送输入。')
def mouse_flags(modifiers):return (8 if 'control' in modifiers else 0)|(4 if 'shift' in modifiers else 0)
def mouse_message(view,message,flags,position):
    result=C.c_size_t()
    if not user32.SendMessageTimeoutW(view['hwnd'],message,flags,position,2|32,1000,C.byref(result)):fail('NATIVE_INPUT_TIMEOUT','原生鼠标事件尚未确认，未自动重试。')
def native_input_action(session,view,args):
    expected(session,view,args)
    if args['action']['kind'] in ['click','move','drag','scroll'] and args.get('expectedLayoutRevision') is None:fail('STALE_COORDINATES','坐标输入必须绑定实际区域布局版本。')
    if args.get('expectedLayoutRevision') is not None and args['expectedLayoutRevision']!=view['layoutRevision']:fail('STALE_COORDINATES','原生区域已经变化，请重新定位。')
    if not view['visible'] or not user32.IsWindowVisible(view['hwnd']):fail('NATIVE_VIEW_HIDDEN','输入目标当前不可见。')
    if not native_geometry(view):fail('NATIVE_GEOMETRY_UNAVAILABLE','原生区域与阅读器布局尚未一致。')
    action=args['action'];kind=action['kind'];density=view_scale(view);client=rectangle(view['hwnd'],True);actor=args.get('actor','agent');modifiers=action.get('modifiers',[]);flags=mouse_flags(modifiers)
    def coordinate(point):
        x=round(point['x']*density);y=round(point['y']*density)
        if x<0 or y<0 or x>=client['width'] or y>=client['height']:fail('INVALID_INPUT_TARGET','输入位置不在原生编辑器内。')
        return x,y,(y<<16)|(x&65535)
    if kind in ['click','move','scroll']:
        x,y,position=coordinate(action)
        if kind=='move':mouse_message(view,0x200,flags,position)
        elif kind=='click':
            buttons={'left':(0x201,0x202,1),'right':(0x204,0x205,2),'middle':(0x207,0x208,16)};down,up,flag=buttons[action.get('button','left')]
            for count in range(action.get('clickCount',1)):mouse_message(view,down,flags|flag,position);mouse_message(view,up,flags,position)
        else:
            point=W.POINT(x,y);user32.ClientToScreen(view['hwnd'],C.byref(point));position=((point.y&65535)<<16)|(point.x&65535)
            if action.get('deltaY'):mouse_message(view,0x20a,((-int(action['deltaY'])&65535)<<16)|flags,position)
            if action.get('deltaX'):mouse_message(view,0x20e,((int(action['deltaX'])&65535)<<16)|flags,position)
    elif kind=='drag':
        x,y,start=coordinate(action['from']);end_x,end_y,end=coordinate(action['to']);mouse_message(view,0x201,flags|1,start)
        for index in range(1,action.get('steps',12)+1):
            fraction=index/action.get('steps',12);position=(round(y+(end_y-y)*fraction)<<16)|(round(x+(end_x-x)*fraction)&65535);mouse_message(view,0x200,flags|1,position)
        mouse_message(view,0x202,flags,end)
    elif kind in ['type','press']:
        # Keyboard input is scoped to a verified owned foreground surface; never type into other apps.
        focus_input(view)
        keys=[];modifiers={'shift':16,'control':17,'alt':18,'meta':91};modifier_keys=[modifiers[v] for v in action.get('modifiers',[])]
        keys.extend(key_event(v) for v in modifier_keys)
        if kind=='type':
            encoded=action['text'].encode('utf-16-le');units=struct.unpack('<'+'H'*(len(encoded)//2),encoded)
            for unit in units:keys.extend([key_event(0,False,unit,True),key_event(0,True,unit,True)])
        else:
            named={'Enter':13,'Backspace':8,'Delete':46,'Escape':27,'Tab':9,'ArrowLeft':37,'ArrowUp':38,'ArrowRight':39,'ArrowDown':40,'Home':36,'End':35,'PageUp':33,'PageDown':34,'Space':32};key=action['key'];vk=named.get(key)
            if vk is None and len(key)==1:vk=ord(key.upper())
            if vk is None and re.fullmatch(r'F([1-9]|1[0-9]|2[0-4])',key):vk=111+int(key[1:])
            if vk is None:fail('INVALID_NATIVE_KEY','按键不可用。')
            keys.extend([key_event(vk),key_event(vk,True)])
        keys.extend(key_event(v,True) for v in reversed(modifier_keys));send_keys(keys)
    else:fail('INVALID_NATIVE_INPUT','原生输入类型不支持。')
    view.pop('captureCache',None);view.pop('accessibilityCache',None);view['actor']=actor;return {'state':state(session,view)}
def native_input(session,view,args):
    action=args['action'];kind=action['kind'];held=[]
    if kind in ['click','move','drag','scroll']:
        expected(session,view,args)
        if args.get('expectedLayoutRevision')!=view['layoutRevision']:fail('STALE_COORDINATES','坐标输入必须绑定实际区域布局版本。')
        if not view['visible'] or not user32.IsWindowVisible(view['hwnd']):fail('NATIVE_VIEW_HIDDEN','输入目标当前不可见。')
        keys={'shift':16,'control':17,'alt':18,'meta':91};requested=[keys[v] for v in action.get('modifiers',[])]
        # Unmodified mouse messages stay in our HWND and work without stealing desktop focus.
        # Real modifier keys use SendInput and therefore require the verified own foreground.
        if requested:focus_input(view)
        held=[vk for vk in requested if not (user32.GetAsyncKeyState(vk)&0x8000)]
        if held:send_keys([key_event(vk) for vk in held])
    try:
        result=native_input_action(session,view,args)
        if kind in ['press','type']:
            # SendInput queues OS events. Yield once before reading the authoritative controller;
            # returning the pre-event model would let an immediate save omit this actual input.
            time.sleep(.035);view.pop('accessibilityCache',None);result={'state':state(session,view)}
        if kind in ['scroll','click','drag']:emit({'type':'viewport','sessionId':session['sessionId'],'viewId':view['viewId'],'actor':args.get('actor','agent'),'layoutRevision':view['layoutRevision']})
        return result
    finally:
        if held:send_keys([key_event(vk,True) for vk in reversed(held)])
def open_session(args):
    existing=next((s for s in sessions.values() if s['documentId']==args['documentId']),None)
    if existing:
        if existing['sessionId']!=args['sessionId']:fail('NATIVE_DUPLICATE_WRITER','此文档已由另一原生会话编辑。')
        if args['viewId'] in existing['views']:layout_view(existing['views'][args['viewId']],args);return state(existing,existing['views'][args['viewId']])
        prior={native_handle(c.getFrame()) for c in controllers(existing['doc'])};source=existing['views'][existing['activeViewId']]
        source['internalManaged']=True
        try:dispatcher.executeDispatch(source['frame'],'.uno:NewWindow','',0,())
        finally:source['internalManaged']=False
        new=[c for c in controllers(existing['doc']) if native_handle(c.getFrame()) not in prior]
        if len(new)!=1:fail('NATIVE_VIEW_UNSUPPORTED','引擎未能为同一文档创建独立控制器。')
        view=attach(existing,new[0],args);return state(existing,view)
    if args['format'] not in ['docx','xlsx','pptx']:fail('NATIVE_FORMAT_UNSUPPORTED','原生编辑器格式不支持。')
    path=ROOT/(str(uuid.uuid4())+'.'+args['format']);path.write_bytes(base64.b64decode(args['bytes'],validate=True))
    handler=SafeImportInteraction();doc=desktop.loadComponentFromURL(path.as_uri(),'_blank',0,props({'Hidden':True,'ReadOnly':False,'FilterName':FILTERS[args['format']],'MacroExecutionMode':uno.Any('short',constant('com.sun.star.document.MacroExecMode.NEVER_EXECUTE',0)),'UpdateDocMode':uno.Any('short',constant('com.sun.star.document.UpdateDocMode.NO_UPDATE',0)),'InteractionHandler':handler}))
    if doc is None:fail('NATIVE_OPEN_FAILED','原生引擎未打开文档。')
    session={'sessionId':args['sessionId'],'documentId':args['documentId'],'format':args['format'],'revision':args['revision'],'engineRevision':0,'doc':doc,'unsavedContentChanges':bool(doc.isModified()),'views':{},'disposed':False,'path':path,'lastSnapshot':None,'mappingBytes':path.read_bytes(),'operationActor':None,'actor':'human','requests':{}}
    listener=Modified(session);session['modifyListener']=listener;doc.addModifyListener(listener);sessions[session['sessionId']]=session
    events=DocumentEvents(session);session['documentEvents']=events
    try:doc.addDocumentEventListener(events)
    except:pass
    view=attach(session,doc.getCurrentController(),args);return state(session,view)

sock=socket.socket();sock.bind(('127.0.0.1',0));port=sock.getsockname()[1];sock.close();accept='socket,host=127.0.0.1,port='+str(port)+';urp;StarOffice.ComponentContext'
profile=pathlib.Path(tempfile.gettempdir())/('av-lo-profile-'+uuid.uuid4().hex[:12]);profile.mkdir()
prepare_native_appearance_profile(profile,json.loads(sys.argv[3]) if len(sys.argv)>3 else {'theme':'light','canvasColor':0xf7f5f2})
process=subprocess.Popen([str(PROGRAM/'soffice.com'),'-env:UserInstallation='+profile.as_uri(),'--nologo','--nodefault','--norestore','--accept='+accept],stdin=subprocess.DEVNULL,stdout=subprocess.DEVNULL,stderr=subprocess.DEVNULL,creationflags=0x08000000)
desktop=None
try:
    local=uno.getComponentContext();resolver=local.ServiceManager.createInstanceWithContext('com.sun.star.bridge.UnoUrlResolver',local);ctx=None
    for attempt in range(250):
        try:ctx=resolver.resolve('uno:'+accept);break
        except:
            # Windows soffice.com can return 0 after handing off to its same-profile soffice.bin.
            # The private UNO resolver, not that launcher lifetime, is the readiness authority.
            if process.poll() not in [None,0]:fail('NATIVE_ENGINE_EXITED','专用 Office 引擎启动失败。')
            time.sleep(.2)
    if ctx is None:fail('NATIVE_ENGINE_TIMEOUT','专用 Office 引擎启动超时。')
    sm=ctx.ServiceManager;desktop=sm.createInstanceWithContext('com.sun.star.frame.Desktop',ctx);dispatcher=sm.createInstanceWithContext('com.sun.star.frame.DispatchHelper',ctx);transformer=sm.createInstanceWithContext('com.sun.star.util.URLTransformer',ctx)
    apply_native_appearance(json.loads(sys.argv[3]) if len(sys.argv)>3 else {'theme':'light','canvasColor':0xf7f5f2})
    emit({'type':'ready','engineEpoch':epoch,'engine':'LibreOffice','launcherPid':process.pid})
    while not quitting:
        try:request=requests.get(timeout=.15)
        except queue.Empty:continue
        request_id=request.get('id');method=request.get('method');args=request.get('args',{})
        try:
            if method=='ping':result={'engineEpoch':epoch,'sessions':len(sessions)}
            elif method=='appearance':result=apply_native_appearance(args)
            elif method=='open':result=open_session(args)
            elif method=='shutdown':
                for session in list(sessions.values()):close_session(session,args.get('discard',False))
                if not desktop.terminate():fail('NATIVE_CLOSE_VETO','Office 引擎拒绝退出，原生内容已保留。')
                quitting=True;result={'closed':True}
            else:
                session=session_for(args);view=view_for(session,args)
                if method=='layout':layout_view(view,args);session['activeViewId']=view['viewId'];result=state(session,view)
                elif method=='zoom':
                    controller=view['controller']
                    try:settings=controller.getViewSettings()
                    except:settings=controller
                    if hasattr(settings,'ZoomOnPage'):settings.ZoomOnPage=False
                    if hasattr(settings,'ZoomType'):settings.ZoomType=constant('com.sun.star.view.DocumentZoomType.BY_VALUE',0)
                    settings.ZoomValue=round(args['factor']*100);view['layoutRevision']+=1;view.pop('captureCache',None);view.pop('accessibilityCache',None);result=state(session,view)
                elif method=='state':result=state(session,view)
                elif method=='snapshot':result=snapshot(session,view,known=args.get('known'))
                elif method=='capture':result=capture(session,view,args.get('rect'))
                elif method=='commands':result=commands(session,view)
                elif method=='commandStatus':result=command_status(view,args['command'])
                elif method=='query':result=query(session,view,args['target'])
                elif method=='authoringQuery':result=authoring_query_request(session,view,args)
                elif method=='authoringExecute':result=authoring_execute(session,view,args)
                elif method=='input':
                    key='input:'+args['idempotencyKey'];signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest();prior=session['requests'].get(key)
                    if prior:
                        if prior['signature']!=signature:fail('IDEMPOTENCY_CONFLICT','输入请求身份已用于另一操作。')
                        result=prior['result']
                    else:
                        session['operationActor']=args.get('actor','agent')
                        try:result=native_input(session,view,args)
                        finally:session['operationActor']=None
                        session['requests'][key]={'signature':signature,'result':result}
                        if len(session['requests'])>300:session['requests'].pop(next(iter(session['requests'])))
                elif method=='exportCopy':expected(session,view,args);result=snapshot(session,view,args['format'])
                elif method=='overlayOwner':
                    overlay=int(args['hwnd']);overlay_pid=W.DWORD();owner_pid=W.DWORD();user32.GetWindowThreadProcessId(overlay,C.byref(overlay_pid));user32.GetWindowThreadProcessId(view['owner'],C.byref(owner_pid))
                    if not user32.IsWindow(overlay) or overlay_pid.value!=owner_pid.value:fail('INVALID_NATIVE_OVERLAY','浮层不属于当前阅读器进程。')
                    user32.SetWindowLongPtrW(overlay,-8,view['hwnd']);result=None
                elif method=='detachView':
                    if len(session['views'])==1:fail('NATIVE_LAST_VIEW','请通过文档会话关闭最后一个视图。')
                    view['frame'].close(True);session['views'].pop(view['viewId']);session['activeViewId']=next(iter(session['views']));result=None
                elif method=='navigate':
                    expected(session,view,args);target=args['target'];session['operationActor']=args.get('actor','agent');controller=view['controller']
                    try:
                        if target['kind']=='paragraph':
                            values=checked_native_paragraphs(session);target_paragraph=values[target['paragraphIndex']];cursor=controller.getViewCursor();cursor.gotoRange(target_paragraph.getStart(),False)
                            if target.get('select',False):cursor.gotoRange(target_paragraph.getEnd(),True)
                        elif target['kind']=='page':
                            if session['format']!='docx' or not controller.getViewCursor().jumpToPage(target['pageIndex']+1):fail('INVALID_TARGET','目标页码不可用。')
                        elif target['kind']=='sheet':controller.setActiveSheet(session['doc'].getSheets().getByIndex(target['index']))
                        elif target['kind']=='slide':controller.setCurrentPage(session['doc'].getDrawPages().getByIndex(target['index']))
                        elif target['kind']=='shape':
                            pages=session['doc'].getDrawPages();index=target['slideIndex']
                            if not isinstance(index,int) or isinstance(index,bool) or index<0 or index>=pages.getCount():fail('INVALID_TARGET','目标幻灯片不可用。')
                            page=pages.getByIndex(index);found=[page.getByIndex(i) for i in range(page.getCount()) if getattr(page.getByIndex(i),'Name','')==target['name']]
                            if len(found)!=1:fail('INVALID_TARGET','对象名称不唯一或已经变化，没有猜测目标。')
                            controller.setCurrentPage(page);controller.select(found[0])
                        elif target['kind']=='cell':controller.setActiveSheet(sheet_by_name(session,target['sheetName']));controller.select(checked_range(controller.getActiveSheet(),target['address']))
                        else:fail('INVALID_TARGET','原生导航目标不可用。')
                        view['actor']=args.get('actor','agent');result={'status':'rendered','state':state(session,view)}
                        emit({'type':'viewport','sessionId':session['sessionId'],'viewId':view['viewId'],'actor':args.get('actor','agent'),'layoutRevision':view['layoutRevision']})
                    finally:session['operationActor']=None
                elif method=='execute':
                    key=args['requestId'];signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest();prior=session['requests'].get(key)
                    if prior:
                        if prior['signature']!=signature:fail('IDEMPOTENCY_CONFLICT','请求身份已用于另一操作。')
                        result=prior['result']
                    else:
                        expected(session,view,args);before=session['engineRevision'];session['operationActor']=args.get('actor','agent');manager=session['doc'].getUndoManager()
                        try:
                            try:
                                if args.get('command'):
                                    values={p['name']:uno.Any(p['type'],p['value']) if p.get('type') else p['value'] for p in args.get('args',[])};status=dispatch_command(session,view,args['command'],values,key)
                                elif args.get('style'):
                                    apply_native_style(session,view,args['style'],args);status='applied' if session['engineRevision']!=before else 'no-change'
                                elif args.get('operation',{}).get('kind')=='slides.setShapeStyle':
                                    execute_operation(session,view,args['operation'],args);status='applied' if session['engineRevision']!=before else 'no-change'
                                else:
                                    manager.enterUndoContext('AgentViewer '+(args.get('operation',{}).get('kind') or ('替换选区' if args.get('replacement') else '编辑单元格')))
                                    try:
                                        if args.get('replacement'):replace_selected_text(session,view,args['replacement'],args)
                                        elif args.get('cell'):
                                            cell=args['cell'];set_cell_content(session,checked_range(sheet_by_name(session,cell['sheetName']),cell['address']),cell['content'])
                                        elif args.get('operation'):execute_operation(session,view,args['operation'],args)
                                        else:fail('INVALID_NATIVE_OPERATION','原生修改需要明确的目标。')
                                    finally:manager.leaveUndoContext()
                                    status='applied' if session['engineRevision']!=before else 'no-change'
                                view['actor']=args.get('actor','agent')
                            finally:hide_chrome(view)
                            # State may discover a new selection before a delayed
                            # UNO listener does. Keep this request's provenance
                            # through that read, then retire it for human input.
                            result={'status':status,'state':state(session,view)}
                        finally:session['operationActor']=None
                        if status=='applied':result['undoToken']=undo_state(session).get('token')
                        session['requests'][key]={'signature':signature,'result':result}
                        if len(session['requests'])>300:session['requests'].pop(next(iter(session['requests'])))
                elif method=='dispatch':
                    expected(session,view,args);status=dispatch_command(session,view,args['command'],args.get('args',{}),request_id);result={'status':status,'state':state(session,view)}
                elif method=='undo':
                    expected(session,view,args);before=undo_state(session)
                    if args.get('undoToken')!=before.get('token'):fail('UNDO_CONFLICT','原生撤销目标已经变化。')
                    if not before['canUndo']:fail('NOTHING_TO_UNDO','没有可撤销的原生修改。')
                    session['operationActor']=args.get('actor','agent')
                    try:
                        if session['format']=='pptx':
                            revision=session['engineRevision'];view['controller'].setCurrentPage(view['controller'].getCurrentPage())
                            if session['engineRevision']!=revision or undo_state(session).get('token')!=before.get('token'):fail('UNDO_CONFLICT','结束文字编辑后原生内容或撤销目标已变化，没有撤销旧目标。')
                        session['doc'].getUndoManager().undo();view['actor']=args.get('actor','agent');result={'status':'applied','state':state(session,view),'undoToken':undo_state(session).get('token')}
                    finally:session['operationActor']=None
                elif method=='ackSaved':
                    result={'accepted':acknowledge_saved(session,args),'state':state(session,view)}
                elif method=='close':close_session(session,args.get('discard',False));result={'closed':True}
                else:fail('NATIVE_METHOD_UNSUPPORTED','原生接口不存在。')
            emit({'id':request_id,'ok':True,'result':result})
        except Exception as error:
            message=str(error);code,separator,detail=message.partition('|');emit({'id':request_id,'ok':False,'error':{'code':code if separator else 'NATIVE_ENGINE_ERROR','message':detail if separator else '原生编辑引擎操作失败。'}})
except Exception as error:emit({'type':'diagnostic','code':'NATIVE_STARTUP_FAILED'});emit({'type':'startup-error','message':str(error).split('|')[-1]})
finally:
    clean_profile=quitting and not sessions
    if desktop is not None and not sessions:
        try:desktop.terminate()
        except:pass
    try:process.wait(timeout=15)
    except subprocess.TimeoutExpired:emit({'type':'diagnostic','code':'NATIVE_ENGINE_RETAINED'})
    if clean_profile and profile.parent.resolve()==pathlib.Path(tempfile.gettempdir()).resolve() and re.fullmatch(r'av-lo-profile-[0-9a-f]{12}',profile.name) and not profile.is_symlink():
        # Only this runtime's newly-created private profile; document recovery never lives here.
        for attempt in range(5):
            try:shutil.rmtree(profile);break
            except FileNotFoundError:break
            except OSError:
                if attempt==4:emit({'type':'diagnostic','code':'NATIVE_PROFILE_RETAINED'})
                else:time.sleep(.15)
`;
export const nativeOfficeWorkerSource = nativeOfficeAccessibilitySource + '\n' + nativeOfficeWorkerBody.replace('\nsessions={};', '\n' + nativeOfficeAppearanceSource + '\n' + nativeOfficeStyleSource + '\n' + officeAuthoringSource + '\nsessions={};');
