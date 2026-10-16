import { nativeOfficeWorkerSource } from './worker-source';
import { nativeOfficeStyleSource } from './native-style-source';
import { nativeOfficeAppearanceProfileSource, nativeOfficeAppearanceSource } from './appearance-source';
import { officeKitAbiSource } from './kit-abi-source';
import { officeKitBootstrapSource } from './kit-bootstrap-source';
import { officeKitUpdatePolicySource } from './kit-update-policy-source';
import { officeKitDialogSource } from './kit-dialog-source';
import { officeKitLocaleResourceSource } from './locale-resource-source';
import { officeKitBinarySource } from './kit-binary-source';

/** Trusted shared definitions only: never execute the HWND worker's top level. */
export const officeKitSharedDefinitions = [
  'props', 'constant', 'fail', 'refresh_content_dirtiness', 'saved_ack_notification',
  'Modified', 'SelectionChanged', 'DocumentEvents', 'Status', 'SafeImportInteraction',
  'ManagedDispatch', 'ManagedInterceptor', 'DispatchCompleted', 'url', 'command_status',
  'expected', 'letter', 'range_name', 'selected_text_range', 'selection_actions',
  'ppt_text_parts', 'ppt_text_transaction_target', 'ppt_text_model_range', 'ppt_replace_text', 'ppt_set_shape_text',
  'replace_selected_text', 'selection_signature', 'update_selection_epoch',
  'native_text_container_id', 'native_shape_identity', 'native_range_locator', 'selection',
  'undo_state', 'sheet_by_name', 'checked_range', 'excel_formula_parser', 'set_excel_formula',
  'set_cell_content', 'excel_cell_formula', 'query_cell_range', 'query', 'slide_thumbnail', 'slide_thumbnail_source', 'slide_thumbnail_pending',
  'model_parts', 'native_paragraphs', 'paragraph', 'checked_native_paragraphs', 'mapped_sheet',
  'mapped_slide', 'mapped_shape', 'text_style', 'move_right', 'utf16_index', 'execute_operation',
  'snapshot_diagnostic', 'reconcile_clone_shape_colors', 'store_snapshot_file', 'snapshot',
  'acknowledge_saved', 'commands',
] as const;
export const officeKitOverriddenDefinitions = ['emit', 'view_for', 'state', 'body_accessibility', 'own_ime_pending', 'view_scale', 'hide_chrome', 'dispatch_command', 'native_input', 'capture', 'close_session', 'open_session', 'layout_view'] as const;

const preamble = String.raw`
import ast, base64, builtins, ctypes as C, hashlib, io, json, math, os, pathlib, queue, re, socket, struct, symtable, sys, tempfile, threading, time, urllib.parse, uuid, zipfile, zlib
import xml.etree.ElementTree as ET
class KitRequestQueue:
    # Only disposable observations may move around input. Explicit snapshots,
    # layouts, lifecycle calls and model writes remain ordering fences. A job
    # that has started is never interrupted or restarted by this scheduler.
    reads={'state','surfaceState','office-surface-state','observeState','inspect','commandStatus','commandStatuses','surfaceTiles','office-surface-tiles'}
    interactions={'surfaceInput','office-surface-input','surfaceWindowInput','office-surface-window-input','surfaceWindowAction','office-surface-window-action','surfaceWindowClose','office-surface-window-close','execute','dispatch','input','navigate','navigation','undo'}
    def __init__(self,maxsize=64):self.maxsize=maxsize;self.items=[];self.pending=0;self.condition=threading.Condition();self.burst=0
    def put(self,value):
        with self.condition:
            while self.pending>=self.maxsize:self.condition.wait()
            if value['method'] in self.reads:
                key=(value['method'],json.dumps(value.get('args',{}),sort_keys=True,separators=(',',':')))
                # Never join observations separated by a write or lifecycle
                # fence. Each original caller still receives its own reply id.
                for previous in reversed(self.items):
                    if previous['method'] not in self.reads:break
                    if previous.get('_readKey')==key:
                        previous.setdefault('_followers',[]).append(value);self.pending+=1;return
                value['_readKey']=key
            self.items.append(value);self.pending+=1
    def get_nowait(self):
        with self.condition:
            if not self.items:raise queue.Empty()
            chosen=next((index for index,value in enumerate(self.items) if value['method']!='warmup'),0)
            if self.burst<8:
                for index in range(chosen,len(self.items)):
                    value=self.items[index]
                    method=value['method']
                    if method in self.interactions:chosen=index;break
                    if method=='warmup':continue
                    if method not in self.reads:break
            value=self.items.pop(chosen);self.burst=self.burst+1 if chosen else 0
            self.pending-=1+len(value.get('_followers',[]));self.condition.notify_all();return value
    def empty(self):
        with self.condition:return not self.items
config=json.loads(os.environ.pop('AGENTVIEWER_OFFICE_KIT_CONFIG'))
ROOT=pathlib.Path(config['directory']).resolve();PROGRAM=pathlib.Path(config['program']).resolve();ROOT.mkdir(parents=True,exist_ok=True)
sessions={};warmup_document=None;epoch=str(uuid.uuid4());quitting=False;output_lock=threading.RLock();request_queue=KitRequestQueue(maxsize=64);callback_refs=[];office=None;adapter=None;rpc=None
${officeKitBinarySource}
def emit(value):return kit_emit(value)
def fail(code,message):raise RuntimeError(code+'|'+message)
def open_trace(args,stage,started=None):
    if not args.get('_openRequestId'):return
    emit({'type':'open-trace','requestId':args['_openRequestId'],'sessionId':args['sessionId'],'viewId':args['viewId'],'stage':stage,**({'durationMs':round((time.monotonic()-started)*1000,2)} if started is not None else {})})
${officeKitBootstrapSource}
${officeKitUpdatePolicySource}
${nativeOfficeAppearanceProfileSource}
${officeKitLocaleResourceSource}
try:
    if config['rpc'].get('host')!='127.0.0.1':fail('OFFICE_KIT_RPC_HOST','Office 私有连接必须在本机。')
    rpc=socket.create_connection(('127.0.0.1',int(config['rpc']['port'])),timeout=15);kit_negotiate_transport(rpc,config['rpc']['token']);config['rpc'].pop('token',None)
    os.environ['PATH']=str(PROGRAM)+';'+os.environ.get('PATH','');os.environ['SAL_USE_VCLPLUGIN']='svp';os.environ['SAL_SKIA']='raster';os.environ['SAL_LOG']='-WARN'
    bootstrap_dll_directories=[os.add_dll_directory(str(PROGRAM))];sal=C.CDLL(str(PROGRAM/'sal3.dll'));sal.osl_setCommandArgs.argtypes=[C.c_int,C.POINTER(C.c_char_p)];sal.osl_setCommandArgs.restype=None;native_args=(C.c_char_p*1)(b'AgentViewerEmbeddedOffice');sal.osl_setCommandArgs(1,native_args)
    sal.osl_getCommandArgCount.argtypes=[];sal.osl_getCommandArgCount.restype=C.c_ulong
    if sal.osl_getCommandArgCount()!=0:fail('OFFICE_KIT_HOST_ARGUMENTS','Office 内置宿主不能带启动命令参数。')
    dll=C.CDLL(str(PROGRAM/'mergedlo.dll'));adapter=C.CDLL(config['adapterPath']);adapter.av_kit_windows_install.argtypes=[];adapter.av_kit_windows_install.restype=C.c_int;adapter.av_kit_windows_uninstall.argtypes=[];adapter.av_kit_windows_uninstall.restype=C.c_int
    emit({'type':'diagnostic','code':'OFFICE_KIT_DLL_LOADED'})
    if kit_transport_failed:raise RuntimeError('OFFICE_KIT_CONNECTION_LOST|Office 私有连接已中断。')
    if adapter.av_kit_windows_install()!=0:fail('OFFICE_KIT_NATIVE_ADAPTER_UNAVAILABLE','Office 本机渲染适配器与引擎版本不匹配。')
    emit({'type':'diagnostic','code':'OFFICE_KIT_ADAPTER_INSTALLED'})
    if kit_transport_failed:raise RuntimeError('OFFICE_KIT_CONNECTION_LOST|Office 私有连接已中断。')
    bootstrap_started=time.monotonic();emit({'type':'diagnostic','code':'OFFICE_KIT_BOOTSTRAP_BEGIN'})
    bootstrap_context=prepare_bootstrap_profile();profile=bootstrap_context['profile'];prepare_native_appearance_profile(profile,config.get('appearance',{'theme':'light','canvasColor':0xf7f5f2}))
    emit({'type':'diagnostic','code':'OFFICE_KIT_BOOTSTRAP_PREPARED','elapsedMs':round((time.monotonic()-bootstrap_started)*1000,2)})
    prepare_kit_update_policy(bootstrap_context)
    ui_resources=prepare_kit_locale_resources(profile)
    emit({'type':'diagnostic','code':'OFFICE_KIT_UI_RESOURCES_SCOPED' if ui_resources['applied'] else 'OFFICE_KIT_UI_RESOURCES_FULL','uiLocale':ui_resources.get('uiLocale'),'loadedLocales':ui_resources.get('loadedLocales'),'resourceBytes':ui_resources.get('resourceBytes'),'reason':ui_resources.get('reason')})
    if kit_transport_failed:raise RuntimeError('OFFICE_KIT_CONNECTION_LOST|Office 私有连接已中断。')
    dll.libreofficekit_hook_2.argtypes=[C.c_char_p,C.c_char_p];dll.libreofficekit_hook_2.restype=C.c_void_p;hook_started=time.monotonic();emit({'type':'diagnostic','code':'OFFICE_KIT_HOOK_BEGIN'});office=dll.libreofficekit_hook_2(str(PROGRAM).encode(),profile.as_uri().encode())
    if not office:fail('OFFICE_KIT_INIT_FAILED','Office 内置排版引擎初始化失败。')
    emit({'type':'diagnostic','code':'OFFICE_KIT_HOOK_INITIALIZED','elapsedMs':round((time.monotonic()-hook_started)*1000,2)})
except BaseException as error:
    emit({'type':'diagnostic','code':'OFFICE_KIT_STARTUP_FAILED'});emit({'type':'startup-error','message':str(error).partition('|')[2] or 'Office 内置引擎启动失败。'});sys.exit(1)
import uno, unohelper
emit({'type':'diagnostic','code':'OFFICE_KIT_UNO_IMPORTED'})
from com.sun.star.awt import XCallback
from com.sun.star.util import XModifyListener
from com.sun.star.view import XSelectionChangeListener
from com.sun.star.frame import XStatusListener, XDispatch, XDispatchProviderInterceptor, XDispatchResultListener
from com.sun.star.document import XDocumentEventListener, XUndoAction
from com.sun.star.task import XInteractionHandler
`;

const sharedLoader = String.raw`
shared_tree=ast.parse(base64.b64decode(SHARED_SOURCE_BASE64).decode('utf-8'))
shared_nodes={node.name:node for node in shared_tree.body if isinstance(node,(ast.FunctionDef,ast.ClassDef))}
missing=[name for name in SHARED_DEFINITIONS if name not in shared_nodes]
if missing:fail('OFFICE_KIT_SHARED_SOURCE_MISMATCH','共享文档命令定义缺失。')
selected_nodes=[]
for node in shared_tree.body:
    if isinstance(node,(ast.FunctionDef,ast.ClassDef)) and node.name in SHARED_DEFINITIONS:selected_nodes.append(node)
    elif isinstance(node,ast.Assign) and all(isinstance(target,ast.Name) and target.id in ['MANAGED_ACTIONS','FILTERS'] for target in node.targets):selected_nodes.append(node)
shared_module=ast.fix_missing_locations(ast.Module(body=selected_nodes,type_ignores=[]))
shared_text=ast.unparse(shared_module)
exec(compile(shared_module,'<trusted-office-model-definitions>','exec'),globals())
del shared_tree,shared_nodes,selected_nodes,shared_module
`;

const surface = String.raw`
def view_for(session,args):
    require_kit_session_available(session)
    view=session['views'].get(args.get('viewId') or session['activeViewId'])
    if not view or view.get('disposed'):fail('NATIVE_VIEW_NOT_FOUND','Office 阅读视图已关闭。')
    doc_call(session,'setView',None,I)(view['kitViewId'])
    return view
def activate(session,view):doc_call(session,'setView',None,I)(view['kitViewId'])
def view_scale(view):return view.get('deviceScaleFactor',1.0)
def own_ime_pending(view):return bool(view.get('composition'))

def native_input_pending(session,view):
    return bool(view.get('composition') or (view.get('nativeEditing') or view.get('caretVisible')) and session['format'] in ['xlsx','pptx'])

def native_input_state(session,view):
    editing=bool(view.get('nativeEditing') or view.get('caretVisible'))
    return {'composing':bool(view.get('composition')),'inFlight':False,'editing':'cell' if editing and session['format']=='xlsx' else 'text' if editing else 'none','modal':any(window.get('visible') and window.get('modal') is True for window in view.get('windows',{}).values())}

class NativeUiDelay:
    def __init__(self,seconds):self.seconds=seconds

def settle_native_input(session,view):
    # Native key handling may commit the model before its coalesced cursor/A11y
    # callback is flushed. A save must acknowledge that actual transition, not
    # guess that two UI turns imply a completed editor. Leave idle time for the
    # lower-priority flush; never replay Return or clear a native state flag.
    deadline=time.monotonic()+2.0
    while native_input_pending(session,view):
        if time.monotonic()>=deadline:fail('NATIVE_PENDING_INPUT','Office 输入仍未稳定，请完成输入或原生对话框后重试。')
        yield NativeUiDelay(.01)

def require_stable_history(session):
    # Impress' active Outliner has a separate text undo manager. The caret
    # callback remains authoritative when EDITING_IN_SELECTION is unavailable.
    # Undoing the document model while that editor is alive is unsafe, including
    # when a different view of the same model owns the unfinished input.
    if session['format']=='pptx' and any(not item.get('disposed') and (item.get('composition') or item.get('nativeEditing') or item.get('caretVisible')) for item in session['views'].values()):
        fail('NATIVE_PENDING_INPUT','幻灯片文字编辑尚未提交，未撤销或重做旧目标。')

def native_history_signature(session):
    manager=session['doc'].getUndoManager()
    return (tuple(manager.getAllUndoActionTitles()),tuple(manager.getAllRedoActionTitles()))

def live_text_history_fingerprint(session,view,event):
    if session['format']!='pptx' or event.get('kind')!='key' or event.get('phase')!='down' or event.get('key','').lower() not in ['z','y'] or not (event.get('modifiers',{}).get('control') or event.get('modifiers',{}).get('meta')) or not (view.get('nativeEditing') or view.get('caretVisible')):return None
    selected=selected_text_range(session,view);details=None
    if selected is not None:
        # History remains available inside grouped text even when a strict
        # top-level mutation target cannot be bound. Observation must not
        # prevent an otherwise valid physical Ctrl+Z/Y from reaching Outliner.
        try:
            target=ppt_text_transaction_target(session,view,selected);details=[target['slide'],target['index'],target['positions'],target['fullText'],inspect_native_style(session,view,'text')['fields']]
        except:details=['unbound-text',selected.getString()]
    return json.dumps([view.get('focusedParagraph'),details,command_status(view,'.uno:Undo'),command_status(view,'.uno:Redo')],sort_keys=True,ensure_ascii=False,default=str)

def reconcile_history_revision(session,revision,history):
    # Some native Impress text undo actions update the real model and undo
    # stacks without delivering XModifyListener. Advance only for an observed
    # history transition, and never duplicate a revision the listener emitted.
    if session['engineRevision']!=revision or native_history_signature(session)==history:return False
    session['engineRevision']+=1;session['unsavedContentChanges']=True;session['actor']=session.get('operationActor') or 'human'
    emit({'type':'changed','sessionId':session['sessionId'],'engineRevision':session['engineRevision'],'actor':session['actor']})
    for item in session['views'].values():
        if not item.get('disposed'):invalidate(session,item)
    return True

def hide_chrome(view):pass
def session_for(args):
    session=sessions.get(args.get('sessionId'))
    if not session or session.get('disposed'):fail('NATIVE_SESSION_NOT_FOUND','Office 文档会话不存在。')
    return session
def event_identity(session,view):return {'sessionId':session['sessionId'],'viewId':view['viewId'],'engineEpoch':epoch}
def invalidate(session,view,rectangle=None):
    if rectangle is None:view['renderGeneration']+=1
    view['projectionEventSequence']=view.get('projectionEventSequence',0)+1
    view['eventSequence']+=1;view.pop('captureCache',None)
    value={'type':'surface','action':'office-surface-invalidate',**event_identity(session,view),'partIndex':view.get('partIndex',0),'renderGeneration':view['renderGeneration'],'engineRevision':session['engineRevision'],'eventSequence':view['eventSequence']}
    if rectangle:value['rectTwips']=rectangle
    emit(value)
def window_event(view,payload):
    try:info=json.loads(payload);identifier=int(info['id']);action=info.get('action');windows=view['windows'];window=windows.get(identifier)
    except:return
    if action=='created':
        size=[int(v.strip()) for v in info.get('size','0,0').split(',')[:2]]
        if len(size)!=2 or min(size)<=0 or max(size)>16384:return
        window={'id':identifier,'instanceId':str(uuid.uuid4()),'kind':info.get('type','dialog'),'width':size[0],'height':size[1],'visible':True,'generation':0};windows[identifier]=window
        if window['kind'] not in ['dialog','child','deck','tooltip']:window['kind']='dialog'
        if info.get('parentId') is not None:window['parentId']=int(info['parentId'])
        if info.get('position'):
            values=[int(v.strip()) for v in info['position'].split(',')[:2]]
            if len(values)==2:window['positionCss']={'x':values[0],'y':values[1]}
    if not window:return
    if action=='close':windows.pop(identifier,None);view.get('dialogBindings',{}).pop(identifier,None);return
    if action in ['invalidate','size_changed']:window['generation']+=1
    if action=='title_changed' or info.get('title') is not None:window['title']=str(info.get('title',''))
    if action=='size_changed':
        values=[int(v.strip()) for v in info.get('size','').split(',')[:2]]
        if len(values)==2 and min(values)>0:window['width'],window['height']=values
    if action in ['show','hide']:window['visible']=action=='show'
    if action=='cursor_invalidate':window['cursor']=parse_rect(info.get('rectangle'))
    if action=='cursor_visible':window['cursorVisible']=info.get('visible','false')=='true'
def kit_callback(session,view):
    @CALLBACK
    def callback(kind,payload,data):
        if session.get('disposed') or session.get('unavailable') or view.get('disposed'):return
        text=payload.decode('utf-8','replace') if payload else '';view['eventSequence']+=1
        # Pinned LibreOfficeKitEnums.h: cursor/selection decorations, pointer
        # style and external-window metadata do not change document text or
        # its geometry. Keep the public sequence fresh for every callback;
        # only the visible-text projection has a narrower invalidation key.
        # Graphic selection (6) can accompany a live object move: retain it,
        # and all content, layout, editing-state and unknown notifications.
        # Calc setClientZoom reports background RGB (52) even before its
        # unchanged-scale guard. That notification alone changes no cell text
        # or geometry; real content/layout and full appearance invalidation
        # remain authoritative. Keep other formats conservative.
        if kind not in (1,2,3,4,5,13,14,17,18,36,42,43) and not (session['format']=='xlsx' and kind==52):view['projectionEventSequence']=view.get('projectionEventSequence',0)+1
        try:
            if kind==0:invalidate(session,view,parse_rect(text))
            elif kind==1:view['caret']=parse_rect(text)
            elif kind==2:view['selectionRects']=parse_rects(text)
            elif kind==3:view['selectionStart']=parse_rect(text)
            elif kind==4:view['selectionEnd']=parse_rect(text)
            elif kind==5:
                view['caretVisible']=text=='true'
                if session['format'] in ['xlsx','pptx']:view['nativeEditing']=view['caretVisible']
            elif kind==6:
                rectangle=parse_rect(text);view['graphicSelection']={'rect':rectangle,'draggable':True,'resizable':True,'rotatable':True} if rectangle else None
            elif kind==7:emit({'type':'application-action','action':'open-url',**event_identity(session,view),'url':text})
            elif kind==13:view['nativeGeometryPending']=True
            elif kind==17:view['cellCursor']=parse_rect(text)
            elif kind==19:view['formula']=text
            elif kind==18:view['mousePointer']=text
            elif kind==14:view['nativePartPending']=True
            elif kind==42:view['cellSelection']=parse_rect(text)
            elif kind==43:view['cellAutoFill']=parse_rect(text)
            elif kind==36:window_event(view,text)
            elif kind==62:
                info=json.loads(text)
                if info.get('content'):view['focusedParagraph']=str(info['content'])
            elif kind==68:
                info=json.loads(text);view['nativeEditing']=info.get('enabled') is True or info.get('enabled')=='true'
        except:
            view['projectionEventSequence']=view.get('projectionEventSequence',0)+1
            emit({'type':'diagnostic','code':'OFFICE_KIT_CALLBACK_PAYLOAD'})
    callback_refs.append(callback);return callback
def unregister_kit_callback(session,view):
    # Runs on the same non-reentrant UI thread as painting and destruction.
    # Keep both Python/C thunk owners alive until native destruction succeeds.
    activate(session,view)
    change_kit_registration(view,'callback',lambda:doc_call(session,'registerCallback',None,CALLBACK,P)(CALLBACK(),None),lambda:doc_call(session,'registerCallback',None,CALLBACK,P)(view['kitCallback'],None),False)
def release_kit_callback(view):
    callback=view.pop('kitCallback',None)
    if callback is not None:callback_refs[:]=[reference for reference in callback_refs if reference is not callback]
def change_kit_registration(owner,name,remove,add,enabled):
    registrations=owner.setdefault('kitRegistrations',{});current=registrations.get(name,'attached')
    if current==('attached' if enabled else 'detached'):return
    # A failing UNO call may have changed its registration before raising.
    # Normalize unknown state with remove before adding, never duplicate-add.
    if enabled and current=='unknown':
        remove();registrations[name]='detached'
    registrations[name]='unknown';(add if enabled else remove)();registrations[name]='attached' if enabled else 'detached'
def change_kit_bindings(view,enabled):
    # These are registrations owned by this host. In particular Calc/Impress
    # may retain their UNO dispatch/selection adapters after destroyView.
    listener=view.get('selectionListener')
    interceptor=view.get('managedInterceptor')
    bindings=[('selection',lambda:view['controller'].removeSelectionChangeListener(listener),lambda:view['controller'].addSelectionChangeListener(listener)),('dispatch',lambda:view['frame'].releaseDispatchProviderInterceptor(interceptor),lambda:view['frame'].registerDispatchProviderInterceptor(interceptor))]
    if enabled:bindings.reverse()
    for name,remove,add in bindings:
        if (listener if name=='selection' else interceptor) is not None:change_kit_registration(view,name,remove,add,enabled)
def unregister_kit_bindings(view):change_kit_bindings(view,False)
def change_kit_document_bindings(session,enabled):
    document=session['doc'];bindings=[('modify','modifyListener',document.removeModifyListener,document.addModifyListener),('document','documentEvents',document.removeDocumentEventListener,document.addDocumentEventListener)]
    if enabled:bindings.reverse()
    for name,key,remove,add in bindings:
        if session.get(key) is not None:
            listener=session[key];change_kit_registration(session,name,lambda remove=remove,listener=listener:remove(listener),lambda add=add,listener=listener:add(listener),enabled)
def restore_kit_bindings(session,views,document=False):
    if document:change_kit_document_bindings(session,True)
    for view in reversed(views):
        change_kit_bindings(view,True);activate(session,view)
        change_kit_registration(view,'callback',lambda:doc_call(session,'registerCallback',None,CALLBACK,P)(CALLBACK(),None),lambda:doc_call(session,'registerCallback',None,CALLBACK,P)(view['kitCallback'],None),True)
def require_kit_session_available(session):
    if session.get('unavailable'):fail('NATIVE_SESSION_UNAVAILABLE','Office 模型的清理状态未能确认，已停止访问并保留恢复内容。')
def command_statuses(session,view,args):
    commands=args.get('commands')
    if not isinstance(commands,list) or not 1<=len(commands)<=50 or any(not isinstance(command,str) or not re.fullmatch(r'\.uno:[A-Za-z][A-Za-z0-9_]{0,99}',command) for command in commands):fail('INVALID_NATIVE_COMMAND','原生命令名称或查询数量无效。')
    # Read-only status listeners can flush native notifications synchronously.
    # Refuse a mixed capability set if those callbacks change its source lease.
    before=(session['engineRevision'],view['selectionEpoch'])
    results=[command_status(view,command) for command in commands]
    if before!=(session['engineRevision'],view['selectionEpoch']):fail('STALE_NATIVE_QUERY','读取命令状态期间原生文档或选区已变化，请重新读取。')
    return {'sessionId':session['sessionId'],'viewId':view['viewId'],'engineEpoch':epoch,'engineRevision':before[0],'selectionEpoch':before[1],'commands':results}
def unavailable_kit_session(session,reason):
    session['unavailable']=reason;emit({'type':'session-unavailable','sessionId':session['sessionId'],'engineEpoch':epoch,'code':reason})
def rollback_kit_teardown(session,views,document,error):
    try:restore_kit_bindings(session,views,document)
    except Exception as rollback_error:
        unavailable_kit_session(session,'NATIVE_TEARDOWN_ROLLBACK_FAILED')
        raise RuntimeError('NATIVE_SESSION_UNAVAILABLE|Office 监听恢复失败，已停止访问并保留恢复内容。') from rollback_error
    raise error
def parts_state(session):
    count=doc_call(session,'getParts',I)();key=(session['engineRevision'],session.get('partGeometryGeneration',0),count);cache=session.get('partsProjection')
    if cache and cache['key']==key:return cache['parts']
    output=[]
    for index in range(min(count,10000)):
        name=kit_string(doc_call(session,'getPartName',P,I)(index));item={'index':index,'name':name or ('第 '+str(index+1)+' 页')}
        if session['format']=='pptx':
            page=session['doc'].getDrawPages().getByIndex(index);item['sizeTwips']={'width':round(page.Width*1440/2540),'height':round(page.Height*1440/2540)}
        output.append(item)
    session['partsProjection']={'key':key,'parts':output}
    return output
def page_rectangles(session):
    text=kit_string(doc_call(session,'getPartPageRectangles',P)())
    return parse_rects(text)
def project_visible_text(session,view):
    # First pixels need layout and tiles, not a whole-model semantic geometry
    # pass. Only the trusted host's real presentation acknowledgement enables
    # this view's projection; neither a timer nor a requested tile proves that.
    if view.get('contextProjectionEnabled') is not True:view.pop('visibleProjection',None);return '',False,False
    visible=view.get('visibleTwips')
    if not visible or not view.get('visible'):view.pop('visibleProjection',None);return '',False,False
    key=visible_projection_key(session,view);cache=view.get('visibleProjection')
    if not native_input_pending(session,view) and cache and cache['key']==key:return cache['result']
    result=read_visible_text(session,view)
    if result[2] and not native_input_pending(session,view) and key==visible_projection_key(session,view):view['visibleProjection']={'key':key,'result':result}
    else:view.pop('visibleProjection',None)
    return result

def enable_context_projection(session,view):
    if view.get('contextProjectionEnabled') is not True:
        view.pop('visibleProjection',None);view['contextProjectionEnabled']=True
    return {'sessionId':session['sessionId'],'viewId':view['viewId'],'engineEpoch':epoch,'enabled':True}

def visible_projection_key(session,view):
    # Calc text is enumerated from native cell geometry in the actual Twips
    # range. Pure scale changes do not alter that text; layout/content events
    # and the subsequently confirmed range still invalidate it normally.
    if session['format']=='xlsx':return (session['engineRevision'],view.get('partIndex',0),view.get('projectionEventSequence',0),tuple(view.get('visibleTwips',{}).get(k,0) for k in ['x','y','width','height']))
    return (session['engineRevision'],view.get('partIndex',0),view.get('projectionEventSequence',0),view.get('zoom',1),view.get('deviceScaleFactor',1),tuple(view.get('visibleTwips',{}).get(k,0) for k in ['x','y','width','height']))

def read_visible_text(session,view):
    visible=view.get('visibleTwips');result=[];truncated=False
    if not visible or not view.get('visible'):return '',False,False
    try:
        if session['format']=='pptx':
            page=session['doc'].getDrawPages().getByIndex(view.get('partIndex',0))
            for index in range(min(page.getCount(),500)):
                shape=page.getByIndex(index);content=getattr(shape,'String','')
                if content and overlaps(native_rect(shape),visible):result.append(content)
            truncated=page.getCount()>500
        elif session['format']=='xlsx':
            sheet=session['doc'].getSheets().getByIndex(view.get('partIndex',0));cursor=sheet.createCursor();cursor.gotoEndOfUsedArea(False);area=cursor.RangeAddress
            rows=[];columns=[]
            def first_visible(end,axis):
                lo=0;hi=end+1
                while lo<hi:
                    mid=(lo+hi)//2;rectangle=native_rect(sheet.getCellByPosition(mid,0) if axis=='x' else sheet.getCellByPosition(0,mid))
                    if rectangle[axis]+rectangle['width' if axis=='x' else 'height']<=visible[axis]:lo=mid+1
                    else:hi=mid
                return lo
            first_row=first_visible(area.EndRow,'y');first_column=first_visible(area.EndColumn,'x')
            for row in range(first_row,min(area.EndRow+1,first_row+500)):
                rectangle=native_rect(sheet.getCellByPosition(0,row))
                if rectangle['y']>visible['y']+visible['height']:break
                if rectangle['y']+rectangle['height']>=visible['y']:rows.append(row)
            for column in range(first_column,min(area.EndColumn+1,first_column+200)):
                rectangle=native_rect(sheet.getCellByPosition(column,0))
                if rectangle['x']>visible['x']+visible['width']:break
                if rectangle['x']+rectangle['width']>=visible['x']:columns.append(column)
            if len(rows)*len(columns)>2000:truncated=True
            for row in rows:
                for column in columns:
                    if len(result)>=2000:break
                    cell=sheet.getCellByPosition(column,row);content=cell.String
                    if content:result.append(letter(column)+str(row+1)+': '+content)
        else:
            projected=writer_visible_paragraphs(session,view,visible);result=projected['text'];truncated=projected['truncated']
        content='\n'.join(result);return content[:48000],truncated or len(content)>48000,True
    except:return '',False,False
def writer_visible_paragraphs(session,view,visible):
    # A separate view of the SAME LOK model provides real native page geometry.
    # Its cursor never replaces the user's selection or creates another writer.
    probe=session.get('semanticView');cache=session.get('paragraphProjection')
    if probe is None:
        prior=doc_call(session,'getView',I)();previous=list(model_controllers(session['doc']));view['internalManaged']=True
        try:identifier=doc_call(session,'createView',I)()
        finally:view['internalManaged']=False
        new=[v for v in model_controllers(session['doc']) if all(v!=p for p in previous)]
        if len(new)!=1:doc_call(session,'setView',None,I)(prior);fail('OFFICE_KIT_SEMANTIC_VIEW_UNAVAILABLE','同模型阅读几何视图不可用。')
        probe={'kitViewId':identifier,'controller':new[0]};session['semanticView']=probe
    try:
        pages=page_rectangles(session)
        if not pages:fail('OFFICE_KIT_SEMANTIC_GEOMETRY_UNAVAILABLE','原生页面几何尚未就绪。')
        if not cache or cache['revision']!=session['engineRevision'] or cache['pages']!=pages:
            doc_call(session,'setView',None,I)(probe['kitViewId']);cursor=probe['controller'].getViewCursor();paragraphs=native_paragraphs(session['doc'].Text);items=[];factor=1440/2540;page_styles=session['doc'].StyleFamilies.getByName('PageStyles');style_geometry={}
            for index,paragraph in enumerate(paragraphs[:2000]):
                cursor.gotoRange(paragraph.getStart(),False);page=max(0,cursor.getPage()-1);start=cursor.getPosition();style_name=cursor.PageStyleName
                if style_name not in style_geometry:
                    style=page_styles.getByName(style_name);style_geometry[style_name]={'left':style.LeftMargin*factor,'top':style.TopMargin*factor,'right':style.RightMargin*factor}
                metrics=style_geometry[style_name];left=metrics['left'];top=metrics['top'];height=max(1,float(cursor.CharHeight)*20)
                cursor.gotoRange(paragraph.getEnd(),False);end=cursor.getPosition()
                # Official SwXTextViewCursor::getPosition subtracts the current
                # page margins and DOCUMENTBORDER from the real char rectangle.
                # Page geometry supplies the rendered document's border origin.
                rectangle={'x':pages[0]['x']+left,'y':start.Y*factor+top+pages[0]['y'],'width':max(1,pages[page]['width']-left-metrics['right']) if page<len(pages) else 1,'height':max(height,(end.Y-start.Y)*factor+height)}
                items.append({'rect':rectangle,'text':paragraph.String,'page':page})
            cache={'revision':session['engineRevision'],'pages':pages,'items':items,'truncated':len(paragraphs)>2000};session['paragraphProjection']=cache
        return {'text':[item['text'] for item in cache['items'] if item['text'] and overlaps(item['rect'],visible)],'truncated':cache['truncated']}
    finally:activate(session,view)
def model_controllers(doc):
    enum=doc.getControllers();values=[]
    while enum.hasMoreElements():values.append(enum.nextElement())
    return values
def surface_size(session,view):
    size=kit_size(session)
    # Calc's advertised tile extent initially follows its populated area. A
    # checked native cell target can legitimately lie beyond that area; extend
    # only this view's sheet spacer, without adding cells to the file's used range.
    if session['format']=='xlsx':
        extent=view.get('sheetExtents',{}).get(view.get('partIndex',0),{})
        size={axis:max(size[axis],extent.get(axis,0)) for axis in ['width','height']}
    return size

def refresh_surface_geometry(session,view):
    # Size/part callbacks can be repeated or describe a temporary page used by
    # GraphicExportFilter. Never re-enter the native API from its callback.
    # At a safe UI boundary, compare actual final size, pages and part geometry
    # before retiring any public coordinate epoch or thumbnail receipt.
    if not view.get('nativeGeometryPending') and not view.get('nativePartPending') and 'nativeGeometrySignature' in view:return False
    view['nativeGeometryPending']=False;view['nativePartPending']=False;activate(session,view)
    part=doc_call(session,'getPart',I)();size=kit_size(session);count=doc_call(session,'getParts',I)();geometry=None
    if session['format']=='pptx':
        pages=session['doc'].getDrawPages();geometry=[(page.Name,page.Width,page.Height) for page in (pages.getByIndex(index) for index in range(pages.getCount()))]
    signature=json.dumps([size,count,page_rectangles(session),geometry],sort_keys=True,separators=(',',':'))
    previous=view.get('nativeGeometrySignature');view['nativeGeometrySignature']=signature
    geometry_changed=previous is not None and previous!=signature;part_changed=part!=view.get('nativeGeometryPart',part);view['nativeGeometryPart']=part;view['partIndex']=part
    if not geometry_changed and not part_changed:return False
    if geometry_changed:session['partGeometryGeneration']=session.get('partGeometryGeneration',0)+1
    view['layoutRevision']+=1;view['projectionEventSequence']=view.get('projectionEventSequence',0)+1;invalidate(session,view)
    return True

def refresh_pending_surface_geometries(session):
    previous=doc_call(session,'getView',I)()
    try:
        for item in session.get('views',{}).values():
            if not item.get('disposed') and (item.get('nativeGeometryPending') or item.get('nativePartPending')):refresh_surface_geometry(session,item)
    finally:doc_call(session,'setView',None,I)(previous)

def state(session,view):
    activate(session,view);refresh_surface_geometry(session,view);selected=selection(session,view);update_selection_epoch(session,view,selected);native_dirty=refresh_content_dirtiness(session);size=surface_size(session,view)
    visible,truncated,ready=project_visible_text(session,view);activate(session,view)
    bounds=view.get('bounds',{'x':0,'y':0,'width':0,'height':0});visibleArea=view.get('visibleTwips',{'x':0,'y':0,'width':0,'height':0});viewport=view.get('viewportCss',{'width':0,'height':0});scrollGeometry=surface_scroll_geometry(session,view);scroll=scrollGeometry['scroll'] if scrollGeometry else {axis:visibleArea[axis]*view.get('zoom',1)/15 for axis in ['x','y']}
    if selected['kind']!='none' and view.get('selectionRects'):
        rectangle=view['selectionRects'][0];factor=view.get('zoom',1)/15;origin=view.get('documentOriginCss',{'x':max(0,(viewport['width']-size['width']*factor)/2)-visibleArea['x']*factor,'y':-visibleArea['y']*factor});selected['rect']={'x':rectangle['x']*factor+origin['x'],'y':rectangle['y']*factor+origin['y'],'width':rectangle['width']*factor,'height':rectangle['height']*factor}
    supported=['office.formatText','office.setTextStyle','word.setBlock','word.setParagraphFormat','word.insertParagraph','word.deleteParagraph','word.insertTable','word.setPageLayout'] if session['format']=='docx' else ['slides.setText','slides.setShapeBounds','slides.setShapeStyle','slides.addTextShape','slides.deleteShape','slides.addSlide','slides.deleteSlide','slides.duplicateSlide','slides.setBackground','slides.setNotes','office.formatText','office.setTextStyle'] if session['format']=='pptx' else ['sheets.setCell','sheets.setRangeValues','sheets.setCellFormat','sheets.setRangeFormat','sheets.mergeCells','sheets.unmergeCells','sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns','sheets.setColumnWidth','sheets.setRowHeight','sheets.addWorksheet','sheets.renameWorksheet','sheets.deleteWorksheet','sheets.setFreeze','sheets.setAutoFilter','sheets.sortRange']
    result=dict(sessionId=session['sessionId'],documentId=session['documentId'],viewId=view['viewId'],format=session['format'],revision=session['revision'],status='ready',surfaceKind='tiled',engineEpoch=epoch,engineRevision=session['engineRevision'],selectionEpoch=view['selectionEpoch'],dirty=native_dirty,unsavedContentChanges=bool(session['unsavedContentChanges']),supportedOperations=supported,selectionActions=selection_actions(session,view,selected),nativeHwnd='0',nativePid=os.getpid(),nativeGeometry=bool(view.get('layoutReady')),visible=bool(view.get('visible')),focused=bool(view.get('focused')),pendingInput=native_input_pending(session,view),actor=view.get('actor',session.get('actor','human')),zoom=view.get('zoom',1),viewport={'width':viewport['width'],'height':viewport['height'],'deviceScaleFactor':view_scale(view),'bounds':bounds,'screenBounds':bounds,'layoutRevision':view['layoutRevision'],'scrollX':scroll['x'],'scrollY':scroll['y']},selection=selected,visibleText=visible,visibleTextReady=ready,visibleTextSource='actual-model-projection' if ready else 'unavailable',visibleTextTruncated=truncated,undo=undo_state(session),nativeUi={'menus':False,'toolbars':False,'statusbar':False,'sidebar':False},sizeTwips=size,parts=parts_state(session),partIndex=doc_call(session,'getPart',I)(),pages=page_rectangles(session),layoutRevision=view['layoutRevision'],renderGeneration=view['renderGeneration'],eventSequence=view['eventSequence'],selectionRects=view.get('selectionRects',[]),windows=list(view['windows'].values()),warnings=['XLSX_NATIVE_COLUMN_WIDTH_METRICS'] if session['format']=='xlsx' else [])
    result['inputState']=native_input_state(session,view)
    if session['format']=='pptx' and result['inputState']['editing']=='text':result['textHistory']={'canUndo':command_status(view,'.uno:Undo')['enabled'],'canRedo':command_status(view,'.uno:Redo')['enabled']}
    for name in ['caret','caretVisible','selectionStart','selectionEnd','graphicSelection','cellCursor','cellSelection','cellAutoFill','mousePointer','focusedParagraph','formula']:
        if view.get(name) is not None:result[name]=view[name]
    return result

def observation_lease(session,view,result=None):
    source=result if result is not None else view
    return {'sessionId':session['sessionId'],'documentId':session['documentId'],'viewId':view['viewId'],'engineEpoch':epoch,'engineRevision':result['engineRevision'] if result is not None else session['engineRevision'],'selectionEpoch':source['selectionEpoch'],'eventSequence':source['eventSequence'],'layoutRevision':source['layoutRevision'],'renderGeneration':source['renderGeneration'],'partGeometryGeneration':session.get('partGeometryGeneration',0)}

def observation_fingerprint(session,view):
    # This private host observation still executes on the real serialized UI
    # thread. It never replaces state(), a public query, or a mutation guard.
    # Without every real listener attached, notifications cannot prove reuse.
    try:
        if session.get('disposed') or session.get('unavailable') or session.get('operationActor') is not None or session.get('exporting') or session.get('acknowledgingSave') is not None:return None
        if any(session.get(name) is None for name in ['modifyListener','documentEvents']):return None
        if any(session.get('kitRegistrations',{}).get(name)!='attached' for name in ['modify','document']):return None
        live=list(session['views'].values())
        if not live or view not in live:return None
        for item in live:
            if item.get('disposed') or item.get('internalManaged') or item.get('windows') or native_input_pending(session,item):return None
            if any(item.get(name) is None for name in ['kitCallback','selectionListener','managedInterceptor']):return None
            if any(item.get('kitRegistrations',{}).get(name)!='attached' for name in ['callback','selection','dispatch']):return None
        # Read native state even when no callbacks arrived. In particular some
        # Outliner history transitions do not emit XModifyListener. Exceptions
        # here are NOT the permissive undo_state() empty-history fallback.
        activate(session,view);dirty=refresh_content_dirtiness(session);manager=session['doc'].getUndoManager()
        undo=tuple(manager.getAllUndoActionTitles());redo=tuple(manager.getAllRedoActionTitles())
        history=(undo,redo,bool(manager.isUndoPossible()),bool(manager.isRedoPossible()),manager.getCurrentUndoActionTitle() if undo else None,manager.getCurrentRedoActionTitle() if redo else None)
        size=surface_size(session,view);part=doc_call(session,'getPart',I)();count=doc_call(session,'getParts',I)();pages=page_rectangles(session)
        # Local geometry/focus/zoom/input/appearance are also part of the
        # receipt. Unknown non-JSON local fields fail closed, so a future
        # native handle cannot silently become an unobserved state source.
        excluded={'controller','frame','kitCallback','selectionListener','managedInterceptor','visibleProjection','captureCache','accessibilityCache','rangeLocatorCache','inputStreams','dialogBindings','observationReceipt'}
        local=[{key:value for key,value in item.items() if key not in excluded} for item in live]
        streams=[[(str(key),entry['sequence'],entry['signature']) for key,entry in item.get('inputStreams',{}).items()] for item in live]
        value={'lease':observation_lease(session,view),'revision':session['revision'],'dirty':dirty,'unsavedContentChanges':session['unsavedContentChanges'],'actor':session.get('actor'),'activeViewId':session.get('activeViewId'),'history':history,'size':size,'part':part,'parts':count,'pages':pages,'appearance':native_appearance,'views':local,'inputStreams':streams}
        return json.dumps(value,sort_keys=True,ensure_ascii=False,separators=(',',':'),allow_nan=False)
    except:return None

def observe_state(session,view,args):
    # Only this method establishes a conditional receipt. A renderer/MCP full
    # read must continue reading the native selection, regardless of this cache.
    before=observation_fingerprint(session,view);prior=view.get('observationReceipt');known=args.get('known')
    if before is not None and prior and prior['fingerprint']==before and isinstance(known,dict) and known.get('token')==prior['token'] and known.get('lease')==prior['lease']:
        return {'unchanged':True,'token':prior['token'],'lease':prior['lease']}
    view.pop('observationReceipt',None);result=state(session,view);after=observation_fingerprint(session,view);lease=observation_lease(session,view,result)
    reply={'unchanged':False,'lease':lease,'state':result}
    if before is not None and before==after and lease==observation_lease(session,view):
        receipt={'fingerprint':after,'lease':lease,'token':str(uuid.uuid4())};view['observationReceipt']=receipt;reply['token']=receipt['token']
    return reply
def layout_view(view,args):
    session=sessions[view['sessionId']];activate(session,view)
    if 'visibleTwips' in args:
        rectangle=rect_values(args['visibleTwips']);viewport=args['viewportCss'];bounds=rect_values(args['boundsCss']);zoom=float(args['zoom']);density=float(args['deviceScaleFactor']);part=checked_integer(args['partIndex'],0,len(parts_state(session))-1)
        if not all(math.isfinite(v) and v>0 for v in [zoom,density,float(viewport['width']),float(viewport['height'])]) or not .25<=zoom<=4 or not .5<=density<=8:fail('INVALID_OFFICE_SURFACE_LAYOUT','Office 缩放或视口无效。')
        requested=checked_integer(args['layoutRevision'],0,2**53-1)
        if requested<view.get('clientLayoutRevision',0):fail('STALE_OFFICE_SURFACE_LAYOUT','Office 视口版本已经更新。')
        view['clientLayoutRevision']=requested;view['layoutRevision']=max(view['layoutRevision']+1,requested)
        if zoom!=view.get('zoom',1) or density!=view.get('deviceScaleFactor',1):invalidate(session,view)
        if part!=doc_call(session,'getPart',I)():doc_call(session,'setPart',None,I)(part);invalidate(session,view)
        view.update(bounds=bounds,viewportCss=viewport,visibleTwips=rectangle,partIndex=part,zoom=zoom,deviceScaleFactor=density,visible=bool(args['visible']),focused=bool(args['focused']),layoutReady=True)
        origin=args.get('documentOriginCss')
        if origin is not None:
            if not all(isinstance(origin.get(k),(int,float)) and not isinstance(origin[k],bool) and math.isfinite(origin[k]) for k in ['x','y']):fail('INVALID_OFFICE_SURFACE_LAYOUT','Office 内容原点无效。')
            view['documentOriginCss']={'x':float(origin['x']),'y':float(origin['y'])}
        geometry_names=['canvasOffsetCss','scrollCss','scrollExtentCss','safeViewportCss'];geometry_count=sum(name in args for name in geometry_names)
        if geometry_count not in [0,len(geometry_names)]:fail('INVALID_OFFICE_SURFACE_LAYOUT','Office 实际滚动几何不完整。')
        if geometry_count:
            geometry={name:dict(args[name]) for name in geometry_names}
            if not all(isinstance(value,(int,float)) and not isinstance(value,bool) and math.isfinite(value) and value>=0 for item in geometry.values() for value in item.values()):fail('INVALID_OFFICE_SURFACE_LAYOUT','Office 实际滚动几何无效。')
            for axis in ['x','y']:
                if geometry['scrollCss'][axis]>geometry['scrollExtentCss'][axis]+1 or abs(geometry['canvasOffsetCss'][axis]-geometry['scrollCss'][axis]-view['documentOriginCss'][axis])>.5:fail('INVALID_OFFICE_SURFACE_LAYOUT','Office 实际滚动与内容原点不一致。')
            safe=geometry['safeViewportCss']
            if safe['width']<=0 or safe['height']<=0 or safe['x']+safe['width']>viewport['width']+1 or safe['y']+safe['height']>viewport['height']+1:fail('INVALID_OFFICE_SURFACE_LAYOUT','Office 安全阅读视口无效。')
            view.update(geometry);view['scrollGeometryPartIndex']=part
        else:
            for name in geometry_names+['scrollGeometryPartIndex']:view.pop(name,None)
        pixelWidth=max(1,round(viewport['width']*density));pixelHeight=max(1,round(viewport['height']*density));twipWidth=max(1,round(viewport['width']*15/zoom));twipHeight=max(1,round(viewport['height']*15/zoom))
        doc_call(session,'setClientZoom',None,I,I,I,I)(pixelWidth,pixelHeight,twipWidth,twipHeight);doc_call(session,'setClientVisibleArea',None,I,I,I,I)(*(round(rectangle[k]) for k in ['x','y','width','height']))
    else:
        bounds=rect_values(args['bounds']);view.update(bounds=bounds,viewportCss={'width':bounds['width'],'height':bounds['height']},visible=bool(args['visible']))
def tiles(session,view,args):
    activate(session,view)
    if args['layoutRevision']!=view['layoutRevision'] or args['partIndex']!=view.get('partIndex',0):fail('STALE_OFFICE_SURFACE_LAYOUT','Office 图块视口已经更新。')
    requested=args.get('tiles',[])
    if not isinstance(requested,list) or len(requested)>96:fail('OFFICE_TILE_LIMIT','单次 Office 图块请求过大。')
    output=[];total=0;mode=doc_call(session,'getTileMode',I)();paint_started=time.monotonic()
    for spec in requested:
        rectangle=rect_values(spec['rectTwips']);w=checked_integer(spec['pixelWidth'],1,2048);h=checked_integer(spec['pixelHeight'],1,2048);total+=w*h*4
        if total>64*1024*1024 or rectangle['width']<=0 or rectangle['height']<=0:fail('OFFICE_TILE_LIMIT','Office 图块内存或区域无效。')
        buffer=(C.c_ubyte*(w*h*4))();doc_call(session,'paintTile',None,P,I,I,I,I,I,I)(buffer,w,h,*(round(rectangle[k]) for k in ['x','y','width','height']))
        output.append({'key':spec['key'],'rectTwips':rectangle,'width':w,'height':h,'pixelFormat':'bgra' if mode==1 else 'rgba','alphaMode':'premultiplied','data':kit_pixel_data(buffer)})
    if output and not view.get('firstTileTraced'):
        view['firstTileTraced']=True;open_trace(view,'paint-first-tiles',paint_started)
    return {'state':state(session,view),'partIndex':view.get('partIndex',0),'renderGeneration':view['renderGeneration'],'layoutRevision':view['layoutRevision'],'tiles':output}
`;

const inputAndModel = String.raw`
KEY_NAMES={'Enter':'RETURN','Escape':'ESCAPE','Tab':'TAB','Backspace':'BACKSPACE','Delete':'DELETE','ArrowLeft':'LEFT','ArrowRight':'RIGHT','ArrowUp':'UP','ArrowDown':'DOWN','Home':'HOME','End':'END','PageUp':'PAGEUP','PageDown':'PAGEDOWN','Insert':'INSERT',' ':'SPACE'}
KEY_FALLBACK={'RETURN':1280,'ESCAPE':1281,'TAB':1282,'BACKSPACE':1283,'SPACE':1284,'INSERT':1285,'DELETE':1286,'HOME':1028,'END':1029,'LEFT':1026,'RIGHT':1027,'UP':1024,'DOWN':1025,'PAGEUP':1030,'PAGEDOWN':1031}
def key_code(event):
    key=event.get('key','');code=event.get('code','');name=KEY_NAMES.get(key)
    if name is None and re.fullmatch(r'F(?:[1-9]|1[0-2])',key):name=key
    if name is None and re.fullmatch(r'Key[A-Z]',code):name=code[3:]
    if name is None and re.fullmatch(r'Digit[0-9]',code):name='NUM'+code[5:]
    if name is None:return 0
    fallback=KEY_FALLBACK.get(name,768+int(name[1:])-1 if re.fullmatch(r'F[0-9]+',name) else 512+ord(name)-65 if len(name)==1 and 'A'<=name<='Z' else 256+int(name[3:]) if name.startswith('NUM') else 0)
    value=constant('com.sun.star.awt.Key.'+name,fallback);mod=event.get('modifiers',{})
    return int(value)|(0x1000 if mod.get('shift') else 0)|(0x2000 if mod.get('control') else 0)|(0x4000 if mod.get('alt') else 0)|(0x8000 if mod.get('meta') else 0)
def mouse_modifiers(event):
    mod=event.get('modifiers',{});return (0x1000 if mod.get('shift') else 0)|(0x2000 if mod.get('control') else 0)|(0x4000 if mod.get('alt') else 0)|(0x8000 if mod.get('meta') else 0)
def mouse_buttons(value):return (1 if value&1 else 0)|(4 if value&2 else 0)|(2 if value&4 else 0)
def window_for(session,view,args):
    if args.get('engineEpoch')!=epoch or args.get('sessionId')!=session['sessionId']:fail('STALE_OFFICE_WINDOW','Office 窗口身份已经变化。')
    identifier=checked_integer(args.get('windowId'),1,2**32-1);window=view['windows'].get(identifier)
    if not window or window['instanceId']!=args.get('windowInstanceId'):fail('STALE_OFFICE_WINDOW','Office 窗口已经关闭或重新创建。')
    return window
def decode_bytes(value):
    if isinstance(value,str):return base64.b64decode(value,validate=True)
    if isinstance(value,list) and len(value)<=16*1024*1024 and all(type(v) is int and 0<=v<=255 for v in value):return bytes(value)
    fail('INVALID_OFFICE_INPUT_BYTES','Office 输入内容无效。')
def post_input_event(session,view,event,window=None):
    activate(session,view);kind=event.get('kind');identifier=window['id'] if window else 0
    if kind=='pointer':
        phase=event.get('phase');point=event.get('pointCss' if window else 'pointTwips');x=round(point['x']);y=round(point['y']);click=checked_integer(event.get('clickCount',1),0,3);buttons=mouse_buttons(checked_integer(event.get('buttons',0),0,31));mod=mouse_modifiers(event)
        identity=window['instanceId'] if window else 'document';pressed=view.setdefault('pressedButtons',{})
        if phase=='down':
            buttons={0:1,1:2,2:4}.get(event.get('button'),buttons);pressed[identity]=buttons
        elif phase in ['up','cancel']:
            buttons={0:1,1:2,2:4}.get(event.get('button'),pressed.get(identity,buttons));pressed.pop(identity,None)
        if phase not in ['down','up','move','cancel'] or not all(math.isfinite(float(point[k])) for k in ['x','y']):fail('INVALID_OFFICE_SURFACE_INPUT','Office 指针事件无效。')
        typ=0 if phase=='down' else 1 if phase in ['up','cancel'] else 2
        if window:doc_call(session,'postWindowMouseEvent',None,U,I,I,I,I,I,I)(identifier,typ,x,y,click,buttons,mod)
        else:doc_call(session,'postMouseEvent',None,I,I,I,I,I,I)(typ,x,y,click,buttons,mod)
    elif kind=='key':
        code=key_code(event)
        if not code:return
        typ=0 if event.get('phase')=='down' else 1
        if window:doc_call(session,'postWindowKeyEvent',None,U,I,I,I)(identifier,typ,0,code)
        else:doc_call(session,'postKeyEvent',None,I,I,I)(typ,0,code)
    elif kind=='text':
        text=event.get('text','')
        if not isinstance(text,str) or len(text)>100000 or '\0' in text:fail('INVALID_OFFICE_SURFACE_INPUT','Office 输入文字无效。')
        if not text:return
        doc_call(session,'postWindowExtTextInputEvent',None,U,I,S)(identifier,0,text.encode());doc_call(session,'postWindowExtTextInputEvent',None,U,I,S)(identifier,2,b'')
    elif kind=='composition':
        phase=event.get('phase');text=event.get('text','');identity=event.get('compositionId')
        if phase=='start':
            if view.get('composition'):fail('OFFICE_COMPOSITION_ACTIVE','当前 Office 输入法尚未完成。')
            view['composition']={'id':identity,'windowId':identifier}
        elif not view.get('composition') or view['composition']['id']!=identity or view['composition']['windowId']!=identifier:fail('OFFICE_COMPOSITION_CHANGED','Office 输入法会话已经变化。')
        if not isinstance(text,str) or len(text)>100000 or '\0' in text:fail('INVALID_OFFICE_SURFACE_INPUT','Office 输入法文字无效。')
        if phase in ['start','update','end']:doc_call(session,'postWindowExtTextInputEvent',None,U,I,S)(identifier,0,text.encode())
        if phase in ['end','cancel']:
            if phase=='cancel':doc_call(session,'postWindowExtTextInputEvent',None,U,I,S)(identifier,0,b'')
            doc_call(session,'postWindowExtTextInputEvent',None,U,I,S)(identifier,2,b'');view['composition']=None
    elif kind=='paste':
        items=event.get('items',[])
        if not 1<=len(items)<=16:fail('OFFICE_CLIPBOARD_LIMIT','Office 粘贴格式数量无效。')
        buffers=[decode_bytes(item['data']) for item in items]
        if sum(len(b) for b in buffers)>16*1024*1024:fail('OFFICE_CLIPBOARD_LIMIT','Office 粘贴内容过大。')
        if window:
            chosen=next((i for i,item in enumerate(items) if item['mimeType'].startswith('text/plain')),None)
            if chosen is None:fail('OFFICE_WINDOW_PASTE_FORMAT','此 Office 窗口只接受文字粘贴。')
            payload={'MimeType':{'type':'string','value':items[chosen]['mimeType']},'Data':{'type':'[]byte','value':[value if value<128 else value-256 for value in buffers[chosen]]}}
            doc_call(session,'postWindow',None,U,I,S)(identifier,1,json.dumps(payload).encode())
        else:
            mime=(S*len(items))(*(item['mimeType'].encode() for item in items));lengths=(Z*len(items))(*(len(v) for v in buffers));streams=(S*len(items))(*buffers)
            if not doc_call(session,'setClipboard',I,Z,C.POINTER(S),C.POINTER(Z),C.POINTER(S))(len(items),mime,lengths,streams):fail('OFFICE_CLIPBOARD_FAILED','Office 原生剪贴板未接受内容。')
            doc_call(session,'postUnoCommand',None,S,S,B)(b'.uno:Paste',None,False)
    elif kind=='selection-handle' and not window:
        point=event['pointTwips'];doc_call(session,'setTextSelection',None,I,I,I)(0 if event['edge']=='start' else 1,round(point['x']),round(point['y']))
    elif kind!='barrier':fail('INVALID_OFFICE_SURFACE_INPUT','Office 输入事件不受支持。')
    native_event_fence()
def input_request(session,view,args,window=None):
    stream=args.get('streamId');sequence=checked_integer(args.get('sequence'),1,2**53-1);key=(window['instanceId'] if window else 'document',stream)
    if not isinstance(stream,str) or not 1<=len(stream)<=128:fail('INVALID_OFFICE_INPUT_STREAM','Office 输入流身份无效。')
    signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest();prior=view['inputStreams'].get(key)
    if prior and sequence==prior['sequence']:
        if signature!=prior['signature']:fail('OFFICE_INPUT_SEQUENCE_CONFLICT','Office 输入序号已经用于不同事件。')
        return prior['result']
    if sequence!=(prior['sequence']+1 if prior else 1):fail('OFFICE_INPUT_SEQUENCE_GAP','Office 输入流缺少确认的事件。')
    native_event_fence()
    refresh_surface_geometry(session,view)
    if not window:
        expected_part=checked_integer(args.get('expectedPartIndex'),0,2**31-1)
        if expected_part!=doc_call(session,'getPart',I)():fail('STALE_OFFICE_SURFACE_PART','Office 页或工作表已切换；旧输入未执行，请确认当前目标。')
    if not window and args['event'].get('kind') in ['pointer','selection-handle'] and args.get('layoutRevision')!=view['layoutRevision']:
        event=args['event']
        if event.get('kind')=='pointer' and event.get('phase')=='move' and event.get('buttons')==0:
            # A hover from a retired geometry has no edit to preserve. Consume
            # its FIFO position without posting an obsolete cursor location or
            # poisoning a committed save. Part/session/sequence checks above
            # still apply, and retries receive this same explicit receipt.
            result={'state':state(session,view),'streamId':stream,'ackSequence':sequence,'composing':bool(view.get('composition')),'discarded':{'code':'STALE_OFFICE_SURFACE_LAYOUT','reason':'视口已更新，旧悬停位置未执行。'}}
            result['state']['inputAck']={'streamId':stream,'sequence':sequence,'composing':result['composing']};view['inputStreams'][key]={'sequence':sequence,'signature':signature,'result':result}
            if len(view['inputStreams'])>64:view['inputStreams'].pop(next(iter(view['inputStreams'])))
            return result
        fail('STALE_OFFICE_SURFACE_LAYOUT','Office 输入坐标需要重新定位。')
    history_before=live_text_history_fingerprint(session,view,args['event']) if not window else None;revision_before=session['engineRevision']
    session['operationActor']='human'
    try:
        restore_selection=None;committed_presentation=False
        if not window and args['event'].get('kind')=='barrier':
            if view.get('composition'):fail('NATIVE_PENDING_INPUT','Office 输入法组合尚未完成，未自动提交。')
            if (view.get('nativeEditing') or view.get('caretVisible')) and session['format']=='pptx':view['controller'].setCurrentPage(view['controller'].getCurrentPage());committed_presentation=True
            elif (view.get('nativeEditing') or view.get('caretVisible')) and session['format']=='xlsx':
                restore_selection=view['controller'].getSelection();doc_call(session,'postKeyEvent',None,I,I,I)(0,0,1280);doc_call(session,'postKeyEvent',None,I,I,I)(1,0,1280)
        post_input_event(session,view,args['event'],window);yield;yield
        if committed_presentation and view.get('caretVisible') is False:view['nativeEditing']=False
        if not window and args['event'].get('kind')=='barrier':yield from settle_native_input(session,view)
        if restore_selection is not None:view['controller'].select(restore_selection);native_event_fence();yield
        if not window and args['event'].get('kind')=='barrier':yield from settle_native_input(session,view)
        # PostKeyEvent/IME/accelerators enqueue UI work. An acknowledgement is
        # emitted only after a separate UI turn has processed those events.
        if history_before is not None and session['engineRevision']==revision_before and live_text_history_fingerprint(session,view,args['event'])!=history_before:
            session['engineRevision']+=1;session['unsavedContentChanges']=True;session['actor']='human';emit({'type':'changed','sessionId':session['sessionId'],'engineRevision':session['engineRevision'],'actor':'human'})
            for item in session['views'].values():
                if not item.get('disposed'):invalidate(session,item)
        view['actor']='human';result={'state':state(session,view),'streamId':stream,'ackSequence':sequence,'composing':bool(view.get('composition'))};result['state']['inputAck']={'streamId':stream,'sequence':sequence,'composing':result['composing']};view['inputStreams'][key]={'sequence':sequence,'signature':signature,'result':result}
        if len(view['inputStreams'])>64:view['inputStreams'].pop(next(iter(view['inputStreams'])))
        return result
    finally:session['operationActor']=None
def attach_kit_view(session,controller,args,identifier):
    view={'sessionId':session['sessionId'],'viewId':args['viewId'],'kitViewId':identifier,'controller':controller,'frame':controller.getFrame(),'disposed':False,'selectionEpoch':0,'layoutRevision':0,'renderGeneration':0,'eventSequence':0,'visible':False,'focused':False,'deviceScaleFactor':1,'bounds':{'x':0,'y':0,'width':0,'height':0},'viewportCss':{'width':0,'height':0},'inputStreams':{},'windows':{},'selectionRects':[],'partIndex':0,'actor':'human'}
    view['contextProjectionEnabled']=False
    if args.get('_openRequestId'):view['_openRequestId']=args['_openRequestId']
    session['views'][view['viewId']]=view;session['activeViewId']=view['viewId'];activate(session,view)
    initialize_started=time.monotonic();doc_call(session,'initializeForRendering',None,S)(b'{}');open_trace(args,'initialize-render',initialize_started)
    attach_started=time.monotonic();sync_native_view_appearance(view);callback=kit_callback(session,view);view['kitCallback']=callback;doc_call(session,'registerCallback',None,CALLBACK,P)(callback,None);view['kitRegistrations']={'callback':'attached'}
    doc_call(session,'setAccessibilityState',None,I,B)(identifier,True)
    interceptor=ManagedInterceptor(view);view['managedInterceptor']=interceptor;view['frame'].registerDispatchProviderInterceptor(interceptor);view['kitRegistrations']['dispatch']='attached'
    listener=SelectionChanged(session,view);view['selectionListener']=listener;controller.addSelectionChangeListener(listener);view['kitRegistrations']['selection']='attached'
    if 'bounds' in args:layout_view(view,args)
    open_trace(args,'attach-controller',attach_started)
    return view
def close_warmup_document():
    global warmup_document
    if warmup_document is None:return
    value=warmup_document
    # Keep ownership on failure; a real open must not import alongside an
    # uncertain hidden model or silently discard its disposal error.
    doc_call(value,'destroy',None)();warmup_document=None
    try:value['path'].unlink()
    except OSError:pass
def warmup_step(args):
    global warmup_document
    stage=args.get('stage');identifier=args.get('warmupId')
    if stage=='close':
        if warmup_document and warmup_document['warmupId']==identifier:close_warmup_document()
        return {'completed':True}
    if sessions:
        close_warmup_document();return {'completed':False}
    if stage=='load':
        close_warmup_document();format=args.get('format')
        if format not in ['docx','xlsx','pptx']:fail('INVALID_OFFICE_WARMUP','Office 预热格式无效。')
        data=base64.b64decode(args['bytes'],validate=True)
        if len(data)>1024*1024:fail('INVALID_OFFICE_WARMUP','Office 预热样本过大。')
        path=ROOT/('warmup-'+str(uuid.uuid4())+'.'+format);path.write_bytes(data)
        pointer=office_call('documentLoadWithOptions',P,S,S)(path.as_uri().encode(),b'MacroSecurityLevel=3,EnableMacrosExecution=false')
        if not pointer:
            try:path.unlink()
            except OSError:pass
            fail('OFFICE_WARMUP_FAILED','Office 预热样本加载失败。')
        warmup_document={'kit':pointer,'path':path,'warmupId':identifier,'stage':'load'}
    else:
        if not warmup_document or warmup_document['warmupId']!=identifier:return {'completed':False}
        if stage=='initialize' and warmup_document['stage']=='load':doc_call(warmup_document,'initializeForRendering',None,S)(b'{}');warmup_document['stage']='initialize'
        elif stage=='paint' and warmup_document['stage']=='initialize':
            buffer=(C.c_ubyte*(256*256*4))();doc_call(warmup_document,'setClientZoom',None,I,I,I,I)(256,256,3840,3840);doc_call(warmup_document,'paintTile',None,P,I,I,I,I,I,I)(buffer,256,256,0,0,3840,3840);warmup_document['stage']='paint'
        else:fail('INVALID_OFFICE_WARMUP','Office 预热阶段顺序无效。')
    return {'completed':True}
def open_session(args):
    close_warmup_document()
    existing=next((s for s in sessions.values() if s['documentId']==args['documentId']),None)
    if existing:
        require_kit_session_available(existing)
        if existing['sessionId']!=args['sessionId']:fail('NATIVE_DUPLICATE_WRITER','此文档已经由另一 Office 会话编辑。')
        if args['viewId'] in existing['views']:view=existing['views'][args['viewId']];layout_view(view,args);return view
        previous=model_controllers(existing['doc']);identifier=doc_call(existing,'createView',I)();new=[c for c in model_controllers(existing['doc']) if all(c!=p for p in previous)]
        if len(new)!=1:fail('OFFICE_KIT_VIEW_UNAVAILABLE','Office 没有创建独立的同模型视图。')
        view=attach_kit_view(existing,new[0],args,identifier);return view
    format=args['format']
    if format not in ['docx','xlsx','pptx']:fail('NATIVE_FORMAT_UNSUPPORTED','Office 文档格式不受支持。')
    decode_started=time.monotonic();data=base64.b64decode(args['bytes'],validate=True);open_trace(args,'decode-bytes',decode_started)
    if len(data)>100*1024*1024:fail('NATIVE_DOCUMENT_LIMIT','Office 文档内容过大。')
    write_started=time.monotonic();path=ROOT/(str(uuid.uuid4())+'.'+format);path.write_bytes(data);open_trace(args,'write-managed-file',write_started)
    load_started=time.monotonic();pointer=office_call('documentLoadWithOptions',P,S,S)(path.as_uri().encode(),b'MacroSecurityLevel=3,EnableMacrosExecution=false');open_trace(args,'load-document',load_started)
    if not pointer:fail('NATIVE_OPEN_FAILED','Office 内置引擎未打开文档。')
    provisional={'kit':pointer};expected_type={'docx':0,'xlsx':1,'pptx':2}[format]
    if doc_call(provisional,'getDocumentType',I)()!=expected_type:doc_call(provisional,'destroy',None)();fail('NATIVE_FORMAT_MISMATCH','Office 模型类型与文档身份不一致。')
    bind_started=time.monotonic();enum=desktop.getComponents().createEnumeration();matches=[]
    while enum.hasMoreElements():
        item=enum.nextElement()
        if getattr(item,'URL','')==path.as_uri():matches.append(item)
    if len(matches)!=1:doc_call(provisional,'destroy',None)();fail('OFFICE_KIT_MODEL_NOT_UNIQUE','OfficeKit 与原生对象模型未唯一关联。')
    doc=matches[0];session={'sessionId':args['sessionId'],'documentId':args['documentId'],'format':format,'revision':args['revision'],'engineRevision':0,'doc':doc,'kit':pointer,'unsavedContentChanges':bool(doc.isModified()),'views':{},'disposed':False,'path':path,'lastSnapshot':None,'mappingBytes':data,'operationActor':None,'actor':'human','requests':{}}
    sessions[session['sessionId']]=session;listener=Modified(session);session['modifyListener']=listener;doc.addModifyListener(listener);session['kitRegistrations']={'modify':'attached'}
    events=DocumentEvents(session);session['documentEvents']=events;doc.addDocumentEventListener(events);session['kitRegistrations']['document']='attached'
    open_trace(args,'bind-model',bind_started)
    identifier=doc_call(session,'getView',I)();view=attach_kit_view(session,doc.getCurrentController(),args,identifier)
    return view
def close_session(session,discard=False):
    require_kit_session_available(session)
    if not discard and any(state(session,view)['pendingInput'] for view in session['views'].values()):fail('NATIVE_PENDING_INPUT','Office 文档仍有未提交的实际编辑输入。')
    if refresh_content_dirtiness(session) and not discard:fail('NATIVE_UNSAVED_CHANGES','请先保存或建立恢复快照，再关闭 Office 文档。')
    for view in list(session['views'].values()):
        for window in list(view['windows'].values()):doc_call(session,'postWindow',None,U,I,S)(window['id'],0,None)
    views=list(session['views'].values())
    try:
        for view in views:unregister_kit_callback(session,view);unregister_kit_bindings(view)
        change_kit_document_bindings(session,False)
    except Exception as error:rollback_kit_teardown(session,views,True,error)
    try:doc_call(session,'destroy',None)()
    except Exception as error:
        unavailable_kit_session(session,'NATIVE_DESTROY_UNCONFIRMED')
        raise RuntimeError('NATIVE_SESSION_UNAVAILABLE|Office 模型销毁未能确认，已停止访问并保留恢复内容。') from error
    session['disposed']=True;sessions.pop(session['sessionId'],None)
    # The model has synchronously disposed its controllers/listeners. Global
    # callback roots must no longer retain their source bytes and receipt trees.
    for view in session['views'].values():view['disposed']=True;release_kit_callback(view)
def detach_kit_view(session,view):
    require_kit_session_available(session)
    if len(session['views'])==1:fail('NATIVE_LAST_VIEW','请通过文档会话关闭最后一个视图。')
    try:unregister_kit_callback(session,view);unregister_kit_bindings(view)
    except Exception as error:rollback_kit_teardown(session,[view],False,error)
    try:doc_call(session,'destroyView',None,I)(view['kitViewId'])
    except Exception as error:
        unavailable_kit_session(session,'NATIVE_VIEW_DESTROY_UNCONFIRMED')
        raise RuntimeError('NATIVE_SESSION_UNAVAILABLE|Office 控制器销毁未能确认，已停止访问并保留恢复内容。') from error
    view['disposed']=True;release_kit_callback(view);session['views'].pop(view['viewId']);session['activeViewId']=next(iter(session['views']))
def dispatch_command(session,view,command,values,request_id):
    if command in ['.uno:Undo','.uno:Redo']:require_stable_history(session)
    status=command_status(view,command)
    if not status['enabled']:fail('NATIVE_COMMAND_DISABLED','此命令对当前目标不可用。')
    if command in ['.uno:Undo','.uno:Redo']:
        if values:fail('INVALID_NATIVE_HISTORY_ARGS','当前原生撤销和重做只接受无参数请求。')
        # The document undo manager is the same native history used by the
        # command. Unlike queued postUnoCommand, it confirms the actual model
        # transition before the reply; an active text Outliner was rejected.
        manager=session['doc'].getUndoManager()
        if command=='.uno:Undo':manager.undo()
        else:manager.redo()
        return 'applied'
    # This path reports dispatch, not command completion. In the pinned engine,
    # a DispatchResultListener forces SfxCallMode::SYNCHRON even when the caller
    # requested SynchronMode=false. Dialogs such as Document Properties then run
    # their nested modal loop inside this JSONL request and block further input.
    # Keep the call mode asynchronous and omit the completion listener; model/window
    # callbacks still publish changes, while Undo/Redo above confirm directly.
    activate(session,view);values={**values,'SynchronMode':False}
    payload={name:{'type':'boolean' if type(value) is bool else 'long' if type(value) is int else 'double' if type(value) is float else 'string','value':value} for name,value in values.items()}
    doc_call(session,'postUnoCommand',None,S,S,B)(command.encode(),json.dumps(payload).encode(),False)
    return 'dispatched'

def dispatch_with_history(session,view,command,values,request_id):
    observes_history=command in ['.uno:Undo','.uno:Redo'];revision=session['engineRevision'];history=native_history_signature(session) if observes_history else None
    status=dispatch_command(session,view,command,values,request_id);yield
    if observes_history:
        yield
        reconcile_history_revision(session,revision,history)
        if native_history_signature(session)==history:return 'no-change'
    return status
def png_bytes(raw,width,height,mode):
    pixels=bytearray(raw)
    if mode==1:pixels[0::4],pixels[2::4]=pixels[2::4],pixels[0::4]
    for offset in range(0,len(pixels),4):
        alpha=pixels[offset+3]
        if 0<alpha<255:
            for channel in range(3):pixels[offset+channel]=min(255,round(pixels[offset+channel]*255/alpha))
    def chunk(kind,data):return struct.pack('>I',len(data))+kind+data+struct.pack('>I',zlib.crc32(kind+data)&0xffffffff)
    rows=b''.join(b'\0'+pixels[y*width*4:(y+1)*width*4] for y in range(height))
    return b'\x89PNG\r\n\x1a\n'+chunk(b'IHDR',struct.pack('>IIBBBBB',width,height,8,6,0,0,0))+chunk(b'IDAT',zlib.compress(rows))+chunk(b'IEND',b'')
def clip_capture_geometry(session,view,buffer,width,height,rectangle):
    pages=page_rectangles(session) if session['format']=='docx' else []
    if not pages:
        size=surface_size(session,view);pages=[{'x':0,'y':0,**size}]
    pages=[page for page in pages if overlaps(page,rectangle)];step_x=rectangle['width']/width;step_y=rectangle['height']/height;base=C.addressof(buffer)
    for row in range(height):
        y=rectangle['y']+(row+.5)*step_y;spans=[]
        for page in pages:
            if page['y']<=y<page['y']+page['height']:
                left=max(0,min(width,math.ceil((page['x']-rectangle['x'])/step_x-.5)));right=max(0,min(width,math.ceil((page['x']+page['width']-rectangle['x'])/step_x-.5)))
                if right>left:spans.append((left,right))
        position=0
        for left,right in sorted(spans):
            if left>position:C.memset(base+(row*width+position)*4,0,(left-position)*4)
            position=max(position,right)
        if position<width:C.memset(base+(row*width+position)*4,0,(width-position)*4)
def capture(session,view,crop=None):
    activate(session,view)
    if not view.get('layoutReady'):fail('NATIVE_GEOMETRY_UNAVAILABLE','Office 阅读视口尚未确认。')
    viewport=view['viewportCss'];crop=rect_values(crop or {'x':0,'y':0,**viewport});density=view_scale(view);zoom=view.get('zoom',1);w=round(crop['width']*density);h=round(crop['height']*density)
    if crop['x']<0 or crop['y']<0 or crop['x']+crop['width']>viewport['width']+1 or crop['y']+crop['height']>viewport['height']+1 or w<1 or h<1 or w*h*4>64*1024*1024:fail('INVALID_CAPTURE_RECT','Office 截图范围无效。')
    visible=view['visibleTwips'];origin=view.get('documentOriginCss',{'x':-visible['x']*zoom/15,'y':-visible['y']*zoom/15});rectangle={'x':(crop['x']-origin['x'])*15/zoom,'y':(crop['y']-origin['y'])*15/zoom,'width':crop['width']*15/zoom,'height':crop['height']*15/zoom};buffer=(C.c_ubyte*(w*h*4))();doc_call(session,'paintTile',None,P,I,I,I,I,I,I)(buffer,w,h,*(round(rectangle[k]) for k in ['x','y','width','height']));clip_capture_geometry(session,view,buffer,w,h,rectangle);mode=doc_call(session,'getTileMode',I)();data=png_bytes(bytes(buffer),w,h,mode)
    return {'mimeType':'image/png','data':base64.b64encode(data).decode(),'width':w,'height':h,'deviceScaleFactor':density,'rect':crop,'engineEpoch':epoch,'engineRevision':session['engineRevision'],'layoutRevision':view['layoutRevision'],'sessionId':session['sessionId'],'capturedAt':time.strftime('%Y-%m-%dT%H:%M:%SZ',time.gmtime())}
def paint_window(session,view,args):
    window=window_for(session,view,args)
    if args.get('generation')!=window['generation']:fail('STALE_OFFICE_WINDOW','Office 窗口绘制版本已经更新。')
    width=checked_integer(args['width'],1,4096);height=checked_integer(args['height'],1,4096);density=float(args['deviceScaleFactor'])
    if not .5<=density<=8 or abs(width-window['width']*density)>2 or abs(height-window['height']*density)>2 or width*height*4>64*1024*1024:fail('INVALID_OFFICE_WINDOW_BOUNDS','Office 窗口缓冲区与真实尺寸不一致。')
    buffer=(C.c_ubyte*(width*height*4))();doc_call(session,'paintWindowForView',None,U,P,I,I,I,I,C.c_double,I)(window['id'],buffer,0,0,width,height,density,view['kitViewId']);mode=doc_call(session,'getTileMode',I)()
    return {'state':state(session,view),'windowId':window['id'],'windowInstanceId':window['instanceId'],'generation':window['generation'],'tile':{'key':window['instanceId'],'rectTwips':{'x':0,'y':0,'width':window['width'],'height':window['height']},'width':width,'height':height,'pixelFormat':'bgra' if mode==1 else 'rgba','alphaMode':'premultiplied','data':kit_pixel_data(buffer)}}
`;

const lifecycle = String.raw`
def surface_origin_css(session,view,visible):
    if view.get('scrollGeometryPartIndex')==view.get('partIndex',0) and 'canvasOffsetCss' in view and 'scrollCss' in view:
        return {axis:view['canvasOffsetCss'][axis]-view['scrollCss'][axis] for axis in ['x','y']}
    size=surface_size(session,view);scale=view.get('zoom',1)/15;viewport=view['viewportCss']
    # Match the DOM canvas origin: all formats centre horizontally; only
    # Impress centres a page that is shorter than its real safe viewport.
    return {'x':max(0,(viewport['width']-size['width']*scale)/2)-visible['x']*scale,'y':(max(0,(viewport['height']-size['height']*scale)/2) if session['format']=='pptx' else 0)-visible['y']*scale}

def surface_scroll_geometry(session,view):
    if view.get('scrollGeometryPartIndex')!=view.get('partIndex',0) or not all(name in view for name in ['canvasOffsetCss','scrollCss','scrollExtentCss','safeViewportCss']):return None
    extent=dict(view['scrollExtentCss'])
    if session['format']=='xlsx':
        # A newly revealed real cell grows only the view spacer. Preserve its
        # actual DOM origin and existing padding while allowing that extension.
        size=surface_size(session,view);scale=view.get('zoom',1)/15
        for axis,dimension in [('x','width'),('y','height')]:extent[axis]=max(extent[axis],view['canvasOffsetCss'][axis]+size[dimension]*scale-view['viewportCss'][dimension],0)
    return {'offset':view['canvasOffsetCss'],'scroll':view['scrollCss'],'extent':extent,'safe':view['safeViewportCss']}

def update_surface_scroll(session,view,scroll):
    scale=view.get('zoom',1)/15;size=surface_size(session,view);viewport=view['viewportCss'];view['scrollCss']=dict(scroll)
    origin={axis:view['canvasOffsetCss'][axis]-scroll[axis] for axis in ['x','y']};visible={}
    for axis,dimension in [('x','width'),('y','height')]:
        start=max(0,min(size[dimension],-origin[axis]/scale));end=max(start,min(size[dimension],(viewport[dimension]-origin[axis])/scale));visible[axis]=start;visible[dimension]=end-start
    view['documentOriginCss']=origin;view['visibleTwips']=visible;view['layoutRevision']+=1
    doc_call(session,'setClientVisibleArea',None,I,I,I,I)(*(round(visible[k]) for k in ['x','y','width','height']))
    emit({'type':'surface','action':'office-surface-scroll',**event_identity(session,view),'partIndex':view.get('partIndex',0),'layoutRevision':view['layoutRevision'],'rectTwips':visible,'scrollCss':dict(scroll)})

def native_input(session,view,args):
    expected(session,view,args);action=args['action'];kind=action['kind'];mod={k:k in action.get('modifiers',[]) for k in ['shift','control','alt','meta']}
    if kind in ['click','move','drag','scroll'] and args.get('expectedLayoutRevision')!=view['layoutRevision']:fail('STALE_COORDINATES','Office 坐标操作需要最新布局版本。')
    def point(value):
        if not view.get('layoutReady'):fail('NATIVE_GEOMETRY_UNAVAILABLE','Office 视口尚未确认。')
        x=float(value['x']);y=float(value['y']);viewport=view['viewportCss'];visible=view['visibleTwips']
        if not 0<=x<viewport['width'] or not 0<=y<viewport['height']:fail('INVALID_INPUT_TARGET','操作位置不在 Office 阅读区域内。')
        origin=view.get('documentOriginCss',{'x':-visible['x']*view.get('zoom',1)/15,'y':-visible['y']*view.get('zoom',1)/15});return {'x':(x-origin['x'])*15/view.get('zoom',1),'y':(y-origin['y'])*15/view.get('zoom',1)}
    actor=args.get('actor','agent');session['operationActor']=actor
    try:
        if kind=='type':post_input_event(session,view,{'kind':'text','text':action['text']})
        elif kind=='press':
            key=action['key'];event={'kind':'key','key':key,'code':'Key'+key.upper() if len(key)==1 else key,'modifiers':mod,'phase':'down'};post_input_event(session,view,event);post_input_event(session,view,{**event,'phase':'up'})
        elif kind in ['click','move']:
            event={'kind':'pointer','pointTwips':point(action),'clickCount':action.get('clickCount',1),'modifiers':mod,'buttons':{'left':1,'right':2,'middle':4}.get(action.get('button','left'),1)}
            if kind=='move':post_input_event(session,view,{**event,'phase':'move','buttons':0})
            else:
                post_input_event(session,view,{**event,'phase':'down'});post_input_event(session,view,{**event,'phase':'up'})
        elif kind=='drag':
            start=point(action['from']);end=point(action['to']);steps=action.get('steps',12);event={'kind':'pointer','clickCount':1,'modifiers':mod,'buttons':1}
            post_input_event(session,view,{**event,'phase':'down','pointTwips':start})
            for index in range(1,steps+1):post_input_event(session,view,{**event,'phase':'move','pointTwips':{k:start[k]+(end[k]-start[k])*index/steps for k in ['x','y']}})
            post_input_event(session,view,{**event,'phase':'up','pointTwips':end})
        elif kind=='scroll':
            point(action);geometry=surface_scroll_geometry(session,view)
            if geometry:
                scroll={axis:max(0,min(geometry['extent'][axis],geometry['scroll'][axis]+action.get('delta'+axis.upper(),0))) for axis in ['x','y']};update_surface_scroll(session,view,scroll)
            else:
                visible=dict(view['visibleTwips']);size=surface_size(session,view);visible['x']=max(0,min(size['width']-visible['width'],visible['x']+action.get('deltaX',0)*15/view.get('zoom',1)));visible['y']=max(0,min(size['height']-visible['height'],visible['y']+action.get('deltaY',0)*15/view.get('zoom',1)));view['visibleTwips']=visible;view['layoutRevision']+=1
                view['documentOriginCss']=surface_origin_css(session,view,visible)
                doc_call(session,'setClientVisibleArea',None,I,I,I,I)(*(round(visible[k]) for k in ['x','y','width','height']));emit({'type':'surface','action':'office-surface-scroll',**event_identity(session,view),'partIndex':view.get('partIndex',0),'layoutRevision':view['layoutRevision'],'rectTwips':visible,'scrollCss':{'x':visible['x']*view.get('zoom',1)/15,'y':visible['y']*view.get('zoom',1)/15}})
        else:fail('INVALID_NATIVE_INPUT','Office 输入动作不受支持。')
        yield
        view['actor']=actor;return {'state':state(session,view)}
    finally:session['operationActor']=None
def reveal_native_target(session,view,rectangle):
    if not rectangle or not view.get('layoutReady') or not view.get('visibleTwips'):return
    rectangle=rect_values(rectangle);visible=dict(view['visibleTwips']);scale=view.get('zoom',1)/15
    if session['format']=='xlsx':
        extent=view.setdefault('sheetExtents',{}).setdefault(view.get('partIndex',0),{'width':0,'height':0})
        for axis,dimension in [('x','width'),('y','height')]:extent[dimension]=max(extent[dimension],rectangle[axis]+rectangle[dimension]+24/scale)
    geometry=surface_scroll_geometry(session,view)
    if geometry:
        scroll=dict(geometry['scroll']);safe=geometry['safe']
        for axis,dimension in [('x','width'),('y','height')]:
            margin=min(24,safe[dimension]/6);start=geometry['offset'][axis]+rectangle[axis]*scale;end=start+rectangle[dimension]*scale
            if rectangle[dimension]*scale+2*margin>safe[dimension] or start-scroll[axis]<safe[axis]+margin:position=start-safe[axis]-margin
            elif end-scroll[axis]>safe[axis]+safe[dimension]-margin:position=end-safe[axis]-safe[dimension]+margin
            else:position=scroll[axis]
            scroll[axis]=max(0,min(geometry['extent'][axis],position))
        if any(abs(scroll[axis]-geometry['scroll'][axis])>=.5 for axis in ['x','y']):update_surface_scroll(session,view,scroll)
        return
    size=surface_size(session,view)
    original={'x':visible['x'],'y':visible['y']}
    for axis,extent in [('x','width'),('y','height')]:
        margin=min(24/scale,visible[extent]/6)
        start=rectangle[axis];end=start+rectangle[extent]
        if rectangle[extent]+2*margin>visible[extent] or start<visible[axis]+margin:position=start-margin
        elif end>visible[axis]+visible[extent]-margin:position=end-visible[extent]+margin
        else:position=visible[axis]
        visible[axis]=max(0,min(max(0,size[extent]-visible[extent]),position))
    if all(abs(visible[axis]-original[axis])<.5 for axis in ['x','y']):return
    view['visibleTwips']=visible;view['layoutRevision']+=1
    origin=view.get('documentOriginCss')
    if origin:view['documentOriginCss']=surface_origin_css(session,view,visible)
    doc_call(session,'setClientVisibleArea',None,I,I,I,I)(*(round(visible[k]) for k in ['x','y','width','height']))
    emit({'type':'surface','action':'office-surface-scroll',**event_identity(session,view),'partIndex':view.get('partIndex',0),'layoutRevision':view['layoutRevision'],'rectTwips':visible,'scrollCss':{axis:visible[axis]*scale for axis in ['x','y']}})

def navigate(session,view,args):
    native_event_fence();expected(session,view,args);target=args['target'];controller=view['controller'];kind=target['kind'];session['operationActor']=args.get('actor','agent')
    try:
        if kind=='paragraph':
            values=checked_native_paragraphs(session);paragraph=values[target['paragraphIndex']];cursor=controller.getViewCursor();cursor.gotoRange(paragraph.getStart(),False)
            if target.get('select',False):cursor.gotoRange(paragraph.getEnd(),True)
        elif kind=='page':
            if session['format']!='docx' or not controller.getViewCursor().jumpToPage(target['pageIndex']+1):fail('INVALID_TARGET','Office 目标页码不可用。')
            pages=page_rectangles(session);index=target['pageIndex']
            if index<len(pages):emit({'type':'surface','action':'office-surface-scroll',**event_identity(session,view),'partIndex':0,'layoutRevision':view['layoutRevision'],'rectTwips':pages[index]})
        elif kind=='sheet':controller.setActiveSheet(session['doc'].getSheets().getByIndex(target['index']));doc_call(session,'setPart',None,I)(target['index']);view['partIndex']=target['index']
        elif kind=='slide':controller.setCurrentPage(session['doc'].getDrawPages().getByIndex(target['index']));doc_call(session,'setPart',None,I)(target['index']);view['partIndex']=target['index']
        elif kind=='shape':
            page=session['doc'].getDrawPages().getByIndex(target['slideIndex']);found=[page.getByIndex(i) for i in range(page.getCount()) if getattr(page.getByIndex(i),'Name','')==target['name']]
            if len(found)!=1:fail('INVALID_TARGET','Office 对象名称不唯一或已经变化。')
            controller.setCurrentPage(page);controller.select(found[0]);doc_call(session,'setPart',None,I)(target['slideIndex']);view['partIndex']=target['slideIndex']
        elif kind=='cell':
            controller.setActiveSheet(sheet_by_name(session,target['sheetName']))
            active_index=next(index for index in range(session['doc'].getSheets().getCount()) if session['doc'].getSheets().getByIndex(index).Name==target['sheetName'])
            doc_call(session,'setPart',None,I)(active_index);view['partIndex']=active_index
            rectangle=checked_range(controller.getActiveSheet(),target['address']);controller.select(rectangle)
        else:fail('INVALID_TARGET','Office 导航目标不可用。')
        native_event_fence();view['actor']=args.get('actor','agent');yield
        if kind=='cell':reveal_native_target(session,view,native_rect(rectangle))
        elif kind=='paragraph':reveal_native_target(session,view,view.get('caret'))
        elif kind=='shape':reveal_native_target(session,view,native_rect(found[0]))
        return {'status':'rendered','state':state(session,view)}
    finally:session['operationActor']=None
def execute_request(session,view,args,identifier):
    key=args.get('requestId',identifier);signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).digest();prior=request_receipt(session,key,signature)
    if prior is not None:return prior
    # Only the full-shape Outliner transaction needs this preflight drain before
    # its expected-version check. No mutation has occurred if this fence fails.
    if not args.get('command') and not args.get('style') and args.get('operation',{}).get('kind')=='slides.setText':native_event_fence()
    expected(session,view,args)
    input_state=native_input_state(session,view)
    if input_state['composing'] or input_state['modal']:fail('NATIVE_PENDING_INPUT','请先完成中文输入或关闭原生模态对话框。')
    before=session['engineRevision'];session['operationActor']=args.get('actor','agent');manager=session['doc'].getUndoManager();style_result=None
    try:
        if args.get('command'):
            values={p['name']:p['value'] for p in args.get('args',[])};status=yield from dispatch_with_history(session,view,args['command'],values,key)
        elif args.get('style'):
            style_result=apply_native_style(session,view,args['style'],args);status=style_result['status'] if style_result is not None else 'applied' if session['engineRevision']!=before else 'no-change'
        elif args.get('operation',{}).get('kind')=='slides.setShapeStyle':
            history=native_history_signature(session);execute_operation(session,view,args['operation'],args)
            reconcile_history_revision(session,before,history);status='applied' if session['engineRevision']!=before else 'no-change'
        else:
            history=native_history_signature(session)
            if manager.isLocked():fail('NATIVE_UNDO_BUSY','原生撤销事务尚未结束。')
            manager.enterUndoContext('AgentViewer '+(args.get('operation',{}).get('kind') or ('替换选区' if args.get('replacement') else '编辑单元格')))
            try:
                if args.get('replacement'):replace_selected_text(session,view,args['replacement'],args)
                elif args.get('cell'):
                    cell=args['cell'];set_cell_content(session,checked_range(sheet_by_name(session,cell['sheetName']),cell['address']),cell['content'])
                elif args.get('operation'):execute_operation(session,view,args['operation'],args)
                else:fail('INVALID_NATIVE_OPERATION','Office 修改需要明确的实际目标。')
            finally:manager.leaveUndoContext()
            # The synchronous Outliner transaction has already ended text edit;
            # leaving this context exposes its real native history. A later
            # event-fence failure must not turn an applied mutation into an
            # unrecorded outcome that an idempotent retry could execute again.
            reconcile_history_revision(session,before,history)
            status='applied' if session['engineRevision']!=before else 'no-change'
        view['actor']=args.get('actor','agent');result={'status':status,'state':state(session,view)}
        if style_result is not None:result.update({key:value for key,value in style_result.items() if key in ['historyScope','warnings']})
        if status=='applied' and (style_result is None or style_result.get('historyScope')!='text'):result['undoToken']=undo_state(session).get('token')
        remember_request_receipt(session,key,signature,result)
        return result
    finally:session['operationActor']=None
def request_receipt(session,key,signature):
    digest=hashlib.sha256(key.encode()).digest();seen=session.get('requestSignatures',{}).get(digest)
    if seen is None:return None
    if seen!=signature:fail('IDEMPOTENCY_CONFLICT','Office 请求身份已用于另一操作。')
    prior=session['requests'].get(digest)
    if prior is None:fail('NATIVE_REQUEST_RECEIPT_EXPIRED','Office 操作已经确认，但完整回执已过期；不会重复执行修改。')
    return prior['result']
def remember_request_receipt(session,key,signature,result):
    # Keep exact compact fingerprints for the session lifetime. Evicting the
    # bulky result must never make an old editing identity executable again.
    digest=hashlib.sha256(key.encode()).digest();session.setdefault('requestSignatures',{})[digest]=signature
    size=len(json.dumps(result,ensure_ascii=False,separators=(',',':')).encode())
    session['requests'][digest]={'result':result,'bytes':size};session['requestReceiptBytes']=session.get('requestReceiptBytes',0)+size
    while session['requests'] and (len(session['requests'])>300 or session['requestReceiptBytes']>4*1024*1024):
        retired=session['requests'].pop(next(iter(session['requests'])));session['requestReceiptBytes']-=retired['bytes']
def handle_request(request):
    method=request.get('method');args=request.get('args',{});identifier=request.get('id')
    if method=='ping':return {'engineEpoch':epoch,'sessions':len(sessions),'surfaceKind':'tiled'}
    if method=='warmup':return warmup_step(args)
    if method=='initializeBootstrapSeed':
        try:publish_docless_bootstrap_seed(bootstrap_context)
        except (OSError,ValueError,TypeError,KeyError):emit({'type':'diagnostic','code':'OFFICE_KIT_BOOTSTRAP_CACHE_UNAVAILABLE'})
        return None
    if method=='bootstrapSeed':
        if sessions or desktop.getComponents().createEnumeration().hasMoreElements() or not bootstrap_context.get('ready'):fail('OFFICE_BOOTSTRAP_SEED_UNAVAILABLE','仅能导出未加载任何文档的内置初始化缓存。')
        return {'directory':str(bootstrap_context['seedDirectory']),'manifest':bootstrap_context['manifest']}
    if method=='appearance':
        result=apply_native_appearance(args)
        for session in sessions.values():
            for view in session['views'].values():invalidate(session,view)
        return result
    if method=='open':
        args['_openRequestId']=identifier;open_trace(args,'worker-queue',request.get('_queuedAt'))
        open_session(args);yield
        state_started=time.monotonic();result=state(sessions[args['sessionId']],sessions[args['sessionId']]['views'][args['viewId']]);open_trace(args,'initial-state',state_started);return result
    if method=='shutdown':
        close_warmup_document()
        for session in list(sessions.values()):
            if session.get('unavailable'):
                if not args.get('discard',False):require_kit_session_available(session)
                # An explicit owner shutdown may exit this private process, but
                # must not touch an uncertain pointer or remove recovery bytes.
                continue
            close_session(session,args.get('discard',False))
        global quitting;quitting=True;return {'closed':True}
    session=session_for(args);view=view_for(session,args);refresh_surface_geometry(session,view)
    if method=='enableContextProjection':return enable_context_projection(session,view)
    if method=='observeState':return observe_state(session,view,args)
    if method in ['state','surfaceState','office-surface-state']:return state(session,view)
    if method in ['layout','surfaceLayout','office-surface-layout']:
        layout_started=time.monotonic();layout_view(view,args)
        if method!='layout' and not view.get('firstLayoutTraced'):view['firstLayoutTraced']=True;open_trace(view,'first-layout',layout_started)
        yield;return state(session,view)
    if method in ['surfaceTiles','office-surface-tiles']:return tiles(session,view,args)
    if method in ['surfaceInput','office-surface-input']:return (yield from input_request(session,view,args))
    if method in ['surfaceWindowPaint','office-surface-window-paint']:return paint_window(session,view,args)
    if method in ['surfaceWindowControls','office-surface-window-controls']:
        window=window_for(session,view,args);dialog=read_native_dialog(view,window);return native_dialog_reply(session,view,window['id'],window['instanceId'],dialog)
    if method in ['surfaceWindowAction','office-surface-window-action']:return (yield from dialog_action(session,view,args))
    if method in ['surfaceWindowInput','office-surface-window-input']:return (yield from input_request(session,view,args,window_for(session,view,args)))
    if method in ['surfaceWindowClose','office-surface-window-close']:
        window=window_for(session,view,args);doc_call(session,'postWindow',None,U,I,S)(window['id'],0,None);yield;return state(session,view)
    if method in ['surfaceWindowClipboard','office-surface-window-clipboard']:
        window_for(session,view,args);fail('OFFICE_WINDOW_CLIPBOARD_UNAVAILABLE','当前 OfficeKit 只提供文档视图剪贴板，不能将其当作独立窗口内容。')
    if method=='snapshot':return snapshot(session,view,known=args.get('known'))
    if method=='exportCopy':expected(session,view,args);return snapshot(session,view,args['format'])
    if method=='capture':return capture(session,view,args.get('rect'))
    if method=='commands':return commands(session,view)
    if method=='commandStatus':return command_status(view,args['command'])
    if method=='commandStatuses':return command_statuses(session,view,args)
    if method=='query':return query(session,view,args['target'])
    if method=='inspect':
        # No yields between the values and their selection/version receipt.
        initial=state(session,view);lease=(initial['engineRevision'],initial['selectionEpoch'])
        data=query(session,view,args['target']) if args.get('target') else None
        statuses=command_statuses(session,view,args)['commands'] if args.get('commands') else [] if args.get('commands') is not None else None
        result={'state':state(session,view)}
        if lease!=(result['state']['engineRevision'],result['state']['selectionEpoch']):fail('STALE_NATIVE_QUERY','读取期间原生文档或选区已变化，请重新读取。')
        if args.get('target'):result['data']=data
        if statuses is not None:result['commands']=statuses
        return result
    if method=='execute':return (yield from execute_request(session,view,args,identifier))
    if method=='dispatch':
        expected(session,view,args);session['operationActor']=args.get('actor','agent')
        try:
            status=yield from dispatch_with_history(session,view,args['command'],args.get('args',{}),identifier)
            return {'status':status,'state':state(session,view)}
        finally:session['operationActor']=None
    if method=='input':
        key='input:'+args['idempotencyKey'];signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).digest();prior=request_receipt(session,key,signature)
        if prior is not None:return prior
        result=yield from native_input(session,view,args);remember_request_receipt(session,key,signature,result);return result
    if method in ['navigate','navigation']:return (yield from navigate(session,view,args))
    if method=='undo':
        expected(session,view,args);before=undo_state(session)
        if args.get('undoToken')!=before.get('token'):fail('UNDO_CONFLICT','Office 撤销目标已经变化。')
        if not before['canUndo']:fail('NOTHING_TO_UNDO','没有可撤销的 Office 修改。')
        require_stable_history(session);revision=session['engineRevision'];history=native_history_signature(session)
        session['operationActor']=args.get('actor','agent')
        try:
            session['doc'].getUndoManager().undo();yield;yield
            reconcile_history_revision(session,revision,history)
            return {'status':'applied','state':state(session,view),'undoToken':undo_state(session).get('token')}
        finally:session['operationActor']=None
    if method=='zoom':view['zoom']=args['factor'];view['layoutRevision']+=1;return state(session,view)
    if method=='ackSaved':return {'accepted':acknowledge_saved(session,args),'state':state(session,view)}
    if method=='overlayOwner':return None
    if method=='detachView':
        detach_kit_view(session,view);return None
    if method=='close':close_session(session,args.get('discard',False));return {'closed':True}
    fail('NATIVE_METHOD_UNSUPPORTED','Office 内置接口不存在。')

def verify_shared_globals():
    tables=symtable.symtable(shared_text,'<trusted-office-model-definitions>','exec').get_children();missing=set()
    def visit(table):
        for symbol in table.get_symbols():
            if symbol.is_global() and symbol.is_referenced() and symbol.get_name() not in globals() and not hasattr(builtins,symbol.get_name()):missing.add(symbol.get_name())
        for child in table.get_children():visit(child)
    for table in tables:visit(table)
    if missing:fail('OFFICE_KIT_SHARED_DEPENDENCY_MISSING','共享 Office 模型命令依赖缺失：'+','.join(sorted(missing)))
class RpcPump(unohelper.Base,XCallback):
    def __init__(self):self.active=None;self.request=None;self.executing=False;self.resumeAfter=0.0
    def notify(self,unused):
        if kit_transport_failed:return
        if self.executing:return
        if time.monotonic()<self.resumeAfter:return
        self.resumeAfter=0.0
        if self.active is None:
            try:self.request=request_queue.get_nowait()
            except queue.Empty:return
            self.active=handle_request(self.request)
        try:
            self.executing=True;step=next(self.active)
            if isinstance(step,NativeUiDelay):
                self.resumeAfter=time.monotonic()+step.seconds
                timer=threading.Timer(step.seconds,lambda:async_service.addCallback(self,None));timer.daemon=True;timer.start()
        except StopIteration as completed:
            delivered=True
            for request in [self.request]+self.request.get('_followers',[]):
                if not kit_emit_reply(request,completed.value):delivered=False;break
            self.active=None;self.request=None
            if not delivered:return
            if quitting:shutdown_event.set();return
        except BaseException as error:
            message=str(error);code,separator,detail=message.partition('|')
            for request in [self.request]+self.request.get('_followers',[]):emit({'id':request.get('id'),'ok':False,'error':{'code':code if separator else 'NATIVE_ENGINE_ERROR','message':detail if separator else 'Office 内置引擎操作失败。'}})
            self.active=None;self.request=None
        finally:self.executing=False
        if not kit_transport_failed and not self.resumeAfter and (self.active is not None or not request_queue.empty()):async_service.addCallback(self,None)
def receive_rpc():
    try:
        with kit_rpc_reader as reader:
            while not quitting:
                line=reader.readline(KIT_REQUEST_BYTES_MAX+1)
                if not line:break
                if len(line)>KIT_REQUEST_BYTES_MAX:emit({'type':'diagnostic','code':'NATIVE_PROTOCOL_LIMIT'});break
                value=json.loads(line)
                if not isinstance(value,dict) or not isinstance(value.get('method'),str):fail('NATIVE_PROTOCOL_ERROR','Office 请求结构无效。')
                value['_queuedAt']=time.monotonic();request_queue.put(value);async_service.addCallback(pump,None)
    except:emit({'type':'diagnostic','code':'OFFICE_KIT_CONNECTION_LOST'})
    finally:
        if not quitting:kit_transport_fail()
try:
    if kit_transport_failed:raise RuntimeError('OFFICE_KIT_CONNECTION_LOST|Office 私有连接已中断。')
    version=json.loads(kit_string(office_call('getVersionInfo',P)()))
    if version.get('BuildId')!='bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1':fail('OFFICE_KIT_VERSION_MISMATCH','Office 引擎构建版本未通过接口验证。')
    office_call('setOptionalFeatures',None,C.c_ulonglong)(1<<2)
    ctx=uno.getComponentContext();sm=ctx.ServiceManager;desktop=sm.createInstanceWithContext('com.sun.star.frame.Desktop',ctx);dispatcher=sm.createInstanceWithContext('com.sun.star.frame.DispatchHelper',ctx);transformer=sm.createInstanceWithContext('com.sun.star.util.URLTransformer',ctx);async_service=sm.createInstanceWithContext('com.sun.star.awt.AsyncCallback',ctx)
    verify_shared_globals();pump=RpcPump()
    request_queue.put({'id':'initial-bootstrap','method':'initializeBootstrapSeed','args':{}})
    request_queue.put({'id':'initial-appearance','method':'appearance','args':config.get('appearance',{'theme':'light','canvasColor':0xf7f5f2})});async_service.addCallback(pump,None)
    emit({'type':'ready','engineEpoch':epoch,'engine':'LibreOfficeKit','surfaceKind':'tiled','workerPid':os.getpid(),'officeClassSize':abi_table(office,OfficeTable).nSize,'documentClassSize':C.sizeof(DocumentTable)})
    threading.Thread(target=receive_rpc,daemon=True).start();shutdown_event.wait()
except BaseException as error:
    emit({'type':'diagnostic','code':'OFFICE_KIT_STARTUP_FAILED'});emit({'type':'startup-error','message':str(error).partition('|')[2] or 'Office 内置引擎启动失败。'})
finally:
    if warmup_document:
        try:close_warmup_document()
        except:emit({'type':'diagnostic','code':'OFFICE_WARMUP_CLEANUP_FAILED'})
    if rpc:
        try:rpc.shutdown(socket.SHUT_RDWR)
        except:pass
        try:rpc.close()
        except:pass
    if office and not sessions:
        try:office_call('destroy',None)()
        except:emit({'type':'diagnostic','code':'OFFICE_KIT_DESTROY_FAILED'})
    if adapter and not sessions:
        try:
            if adapter.av_kit_windows_uninstall()!=0:emit({'type':'diagnostic','code':'OFFICE_KIT_ADAPTER_RETAINED'})
        except:pass
    if sessions:emit({'type':'diagnostic','code':'OFFICE_KIT_RECOVERY_RETAINED'})
`;

export const officeKitWorkerSource = preamble
  + '\nSHARED_SOURCE_BASE64=' + JSON.stringify(Buffer.from(nativeOfficeWorkerSource).toString('base64'))
  + '\nSHARED_DEFINITIONS=' + JSON.stringify(officeKitSharedDefinitions)
  + '\n' + sharedLoader + '\n' + nativeOfficeStyleSource + '\n' + nativeOfficeAppearanceSource
  + '\n' + officeKitAbiSource + '\n' + surface + '\n' + inputAndModel + '\n' + officeKitDialogSource + '\n' + lifecycle;
