import { nativeOfficeWorkerSource } from './worker-source';
import { nativeOfficeStyleSource } from './native-style-source';
import { nativeOfficeAppearanceSource } from './appearance-source';
import { officeKitAbiSource } from './kit-abi-source';

/** Trusted shared definitions only: never execute the HWND worker's top level. */
export const officeKitSharedDefinitions = [
  'props', 'constant', 'fail', 'refresh_content_dirtiness', 'saved_ack_notification',
  'Modified', 'SelectionChanged', 'DocumentEvents', 'Status', 'SafeImportInteraction',
  'ManagedDispatch', 'ManagedInterceptor', 'DispatchCompleted', 'url', 'command_status',
  'expected', 'letter', 'range_name', 'selected_text_range', 'selection_actions',
  'ppt_text_parts', 'ppt_text_transaction_target', 'ppt_text_model_range', 'ppt_replace_text',
  'replace_selected_text', 'selection_signature', 'update_selection_epoch',
  'native_text_container_id', 'native_shape_identity', 'native_range_locator', 'selection',
  'undo_state', 'sheet_by_name', 'checked_range', 'excel_formula_parser', 'set_excel_formula',
  'set_cell_content', 'excel_cell_formula', 'query_cell_range', 'query', 'slide_thumbnail',
  'model_parts', 'native_paragraphs', 'paragraph', 'checked_native_paragraphs', 'mapped_sheet',
  'mapped_slide', 'mapped_shape', 'text_style', 'move_right', 'utf16_index', 'execute_operation',
  'snapshot_diagnostic', 'reconcile_clone_shape_colors', 'store_snapshot_file', 'snapshot',
  'acknowledge_saved', 'commands',
] as const;
export const officeKitOverriddenDefinitions = ['emit', 'view_for', 'state', 'body_accessibility', 'own_ime_pending', 'view_scale', 'hide_chrome', 'dispatch_command', 'native_input', 'capture', 'close_session', 'open_session', 'layout_view'] as const;

const preamble = String.raw`
import ast, base64, builtins, ctypes as C, hashlib, io, json, math, os, pathlib, queue, re, socket, struct, symtable, sys, tempfile, threading, time, urllib.parse, uuid, zipfile, zlib
import xml.etree.ElementTree as ET
config=json.loads(os.environ.pop('AGENTVIEWER_OFFICE_KIT_CONFIG'))
ROOT=pathlib.Path(config['directory']).resolve();PROGRAM=pathlib.Path(config['program']).resolve();ROOT.mkdir(parents=True,exist_ok=True)
sessions={};epoch=str(uuid.uuid4());quitting=False;output_lock=threading.RLock();request_queue=queue.Queue(maxsize=64);callback_refs=[];office=None;adapter=None;rpc=None
def emit(value):
    with output_lock:sys.stdout.write(json.dumps(value,ensure_ascii=False,separators=(',',':'))+'\n');sys.stdout.flush()
def fail(code,message):raise RuntimeError(code+'|'+message)
try:
    if config['rpc'].get('host')!='127.0.0.1':fail('OFFICE_KIT_RPC_HOST','Office 私有连接必须在本机。')
    rpc=socket.create_connection(('127.0.0.1',int(config['rpc']['port'])),timeout=15);rpc.settimeout(None);rpc.sendall((json.dumps({'type':'auth','token':config['rpc']['token']})+'\n').encode());config['rpc'].pop('token',None)
    os.environ['PATH']=str(PROGRAM)+';'+os.environ.get('PATH','');os.environ['SAL_USE_VCLPLUGIN']='svp';os.environ['SAL_SKIA']='raster';os.environ['SAL_LOG']='-WARN'
    bootstrap_dll_directories=[os.add_dll_directory(str(PROGRAM))];sal=C.CDLL(str(PROGRAM/'sal3.dll'));sal.osl_setCommandArgs.argtypes=[C.c_int,C.POINTER(C.c_char_p)];sal.osl_setCommandArgs.restype=None;native_args=(C.c_char_p*1)(b'AgentViewerEmbeddedOffice');sal.osl_setCommandArgs(1,native_args)
    sal.osl_getCommandArgCount.argtypes=[];sal.osl_getCommandArgCount.restype=C.c_ulong
    if sal.osl_getCommandArgCount()!=0:fail('OFFICE_KIT_HOST_ARGUMENTS','Office 内置宿主不能带启动命令参数。')
    dll=C.CDLL(str(PROGRAM/'mergedlo.dll'));adapter=C.CDLL(config['adapterPath']);adapter.av_kit_windows_install.argtypes=[];adapter.av_kit_windows_install.restype=C.c_int;adapter.av_kit_windows_uninstall.argtypes=[];adapter.av_kit_windows_uninstall.restype=C.c_int
    emit({'type':'diagnostic','code':'OFFICE_KIT_DLL_LOADED'})
    if adapter.av_kit_windows_install()!=0:fail('OFFICE_KIT_NATIVE_ADAPTER_UNAVAILABLE','Office 本机渲染适配器与引擎版本不匹配。')
    emit({'type':'diagnostic','code':'OFFICE_KIT_ADAPTER_INSTALLED'})
    profile=pathlib.Path(tempfile.gettempdir())/('av-kit-profile-'+uuid.uuid4().hex[:12]);profile.mkdir();dll.libreofficekit_hook_2.argtypes=[C.c_char_p,C.c_char_p];dll.libreofficekit_hook_2.restype=C.c_void_p;office=dll.libreofficekit_hook_2(str(PROGRAM).encode(),profile.as_uri().encode())
    if not office:fail('OFFICE_KIT_INIT_FAILED','Office 内置排版引擎初始化失败。')
    emit({'type':'diagnostic','code':'OFFICE_KIT_HOOK_INITIALIZED'})
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
    view=session['views'].get(args.get('viewId') or session['activeViewId'])
    if not view or view.get('disposed'):fail('NATIVE_VIEW_NOT_FOUND','Office 阅读视图已关闭。')
    doc_call(session,'setView',None,I)(view['kitViewId'])
    return view
def activate(session,view):doc_call(session,'setView',None,I)(view['kitViewId'])
def view_scale(view):return view.get('deviceScaleFactor',1.0)
def own_ime_pending(view):return bool(view.get('composition'))

def native_input_pending(session,view):
    return bool(view.get('composition') or (view.get('nativeEditing') or view.get('caretVisible')) and session['format'] in ['xlsx','pptx'])

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
    if action=='close':windows.pop(identifier,None);return
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
        text=payload.decode('utf-8','replace') if payload else '';view['eventSequence']+=1
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
            elif kind==13:view['layoutRevision']+=1;invalidate(session,view)
            elif kind==17:view['cellCursor']=parse_rect(text)
            elif kind==19:view['formula']=text
            elif kind==18:view['mousePointer']=text
            elif kind==14:
                view['partIndex']=int(text);view['layoutRevision']+=1;invalidate(session,view)
            elif kind==42:view['cellSelection']=parse_rect(text)
            elif kind==43:view['cellAutoFill']=parse_rect(text)
            elif kind==36:window_event(view,text)
            elif kind==62:
                info=json.loads(text)
                if info.get('content'):view['focusedParagraph']=str(info['content'])
            elif kind==68:
                info=json.loads(text);view['nativeEditing']=info.get('enabled') is True or info.get('enabled')=='true'
        except:emit({'type':'diagnostic','code':'OFFICE_KIT_CALLBACK_PAYLOAD'})
    callback_refs.append(callback);return callback
def parts_state(session):
    count=doc_call(session,'getParts',I)();output=[]
    for index in range(min(count,10000)):
        name=kit_string(doc_call(session,'getPartName',P,I)(index));item={'index':index,'name':name or ('第 '+str(index+1)+' 页')}
        if session['format']=='pptx':
            page=session['doc'].getDrawPages().getByIndex(index);item['sizeTwips']={'width':round(page.Width*1440/2540),'height':round(page.Height*1440/2540)}
        output.append(item)
    return output
def page_rectangles(session):
    text=kit_string(doc_call(session,'getPartPageRectangles',P)())
    return parse_rects(text)
def project_visible_text(session,view):
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
                    cell=sheet.getCellByPosition(column,row)
                    if cell.String:result.append(letter(column)+str(row+1)+': '+cell.String)
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
            doc_call(session,'setView',None,I)(probe['kitViewId']);cursor=probe['controller'].getViewCursor();paragraphs=native_paragraphs(session['doc'].Text);items=[];factor=1440/2540
            for index,paragraph in enumerate(paragraphs[:2000]):
                cursor.gotoRange(paragraph.getStart(),False);page=max(0,cursor.getPage()-1);start=cursor.getPosition();style=session['doc'].StyleFamilies.getByName('PageStyles').getByName(cursor.PageStyleName);left=style.LeftMargin*factor;top=style.TopMargin*factor;height=max(1,float(cursor.CharHeight)*20)
                cursor.gotoRange(paragraph.getEnd(),False);end=cursor.getPosition()
                # Official SwXTextViewCursor::getPosition subtracts the current
                # page margins and DOCUMENTBORDER from the real char rectangle.
                # Page geometry supplies the rendered document's border origin.
                rectangle={'x':pages[0]['x']+left,'y':start.Y*factor+top+pages[0]['y'],'width':max(1,pages[page]['width']-left-style.RightMargin*factor) if page<len(pages) else 1,'height':max(height,(end.Y-start.Y)*factor+height)}
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

def state(session,view):
    activate(session,view);selected=selection(session,view);update_selection_epoch(session,view,selected);native_dirty=refresh_content_dirtiness(session);size=surface_size(session,view)
    visible,truncated,ready=project_visible_text(session,view);activate(session,view)
    bounds=view.get('bounds',{'x':0,'y':0,'width':0,'height':0});visibleArea=view.get('visibleTwips',{'x':0,'y':0,'width':0,'height':0});viewport=view.get('viewportCss',{'width':0,'height':0})
    if selected['kind']!='none' and view.get('selectionRects'):
        rectangle=view['selectionRects'][0];factor=view.get('zoom',1)/15;origin=view.get('documentOriginCss',{'x':max(0,(viewport['width']-size['width']*factor)/2)-visibleArea['x']*factor,'y':-visibleArea['y']*factor});selected['rect']={'x':rectangle['x']*factor+origin['x'],'y':rectangle['y']*factor+origin['y'],'width':rectangle['width']*factor,'height':rectangle['height']*factor}
    supported=['office.formatText','office.setTextStyle','word.setBlock','word.setParagraphFormat','word.insertParagraph','word.deleteParagraph','word.insertTable','word.setPageLayout'] if session['format']=='docx' else ['slides.setText','slides.setShapeBounds','slides.setShapeStyle','slides.addTextShape','slides.deleteShape','slides.addSlide','slides.deleteSlide','slides.duplicateSlide','slides.setBackground','slides.setNotes','office.formatText','office.setTextStyle'] if session['format']=='pptx' else ['sheets.setCell','sheets.setRangeValues','sheets.setCellFormat','sheets.setRangeFormat','sheets.mergeCells','sheets.unmergeCells','sheets.insertRows','sheets.deleteRows','sheets.insertColumns','sheets.deleteColumns','sheets.setColumnWidth','sheets.setRowHeight','sheets.addWorksheet','sheets.renameWorksheet','sheets.deleteWorksheet','sheets.setFreeze','sheets.setAutoFilter','sheets.sortRange']
    result=dict(sessionId=session['sessionId'],documentId=session['documentId'],viewId=view['viewId'],format=session['format'],revision=session['revision'],status='ready',surfaceKind='tiled',engineEpoch=epoch,engineRevision=session['engineRevision'],selectionEpoch=view['selectionEpoch'],dirty=native_dirty,unsavedContentChanges=bool(session['unsavedContentChanges']),supportedOperations=supported,selectionActions=selection_actions(session,view,selected),nativeHwnd='0',nativePid=os.getpid(),nativeGeometry=bool(view.get('layoutReady')),visible=bool(view.get('visible')),focused=bool(view.get('focused')),pendingInput=native_input_pending(session,view),actor=view.get('actor',session.get('actor','human')),zoom=view.get('zoom',1),viewport={'width':viewport['width'],'height':viewport['height'],'deviceScaleFactor':view_scale(view),'bounds':bounds,'screenBounds':bounds,'layoutRevision':view['layoutRevision'],'scrollX':visibleArea['x']*view.get('zoom',1)/15,'scrollY':visibleArea['y']*view.get('zoom',1)/15},selection=selected,visibleText=visible,visibleTextReady=ready,visibleTextSource='actual-model-projection' if ready else 'unavailable',visibleTextTruncated=truncated,undo=undo_state(session),nativeUi={'menus':False,'toolbars':False,'statusbar':False,'sidebar':False},sizeTwips=size,parts=parts_state(session),partIndex=doc_call(session,'getPart',I)(),pages=page_rectangles(session),layoutRevision=view['layoutRevision'],renderGeneration=view['renderGeneration'],eventSequence=view['eventSequence'],selectionRects=view.get('selectionRects',[]),windows=list(view['windows'].values()),warnings=['XLSX_NATIVE_COLUMN_WIDTH_METRICS'] if session['format']=='xlsx' else [])
    for name in ['caret','caretVisible','selectionStart','selectionEnd','graphicSelection','cellCursor','cellSelection','cellAutoFill','mousePointer','focusedParagraph','formula']:
        if view.get(name) is not None:result[name]=view[name]
    return result
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
        pixelWidth=max(1,round(viewport['width']*density));pixelHeight=max(1,round(viewport['height']*density));twipWidth=max(1,round(viewport['width']*15/zoom));twipHeight=max(1,round(viewport['height']*15/zoom))
        doc_call(session,'setClientZoom',None,I,I,I,I)(pixelWidth,pixelHeight,twipWidth,twipHeight);doc_call(session,'setClientVisibleArea',None,I,I,I,I)(*(round(rectangle[k]) for k in ['x','y','width','height']))
    else:
        bounds=rect_values(args['bounds']);view.update(bounds=bounds,viewportCss={'width':bounds['width'],'height':bounds['height']},visible=bool(args['visible']))
def tiles(session,view,args):
    activate(session,view)
    if args['layoutRevision']!=view['layoutRevision'] or args['partIndex']!=view.get('partIndex',0):fail('STALE_OFFICE_SURFACE_LAYOUT','Office 图块视口已经更新。')
    requested=args.get('tiles',[])
    if not isinstance(requested,list) or len(requested)>96:fail('OFFICE_TILE_LIMIT','单次 Office 图块请求过大。')
    output=[];total=0;mode=doc_call(session,'getTileMode',I)()
    for spec in requested:
        rectangle=rect_values(spec['rectTwips']);w=checked_integer(spec['pixelWidth'],1,2048);h=checked_integer(spec['pixelHeight'],1,2048);total+=w*h*4
        if total>64*1024*1024 or rectangle['width']<=0 or rectangle['height']<=0:fail('OFFICE_TILE_LIMIT','Office 图块内存或区域无效。')
        buffer=(C.c_ubyte*(w*h*4))();doc_call(session,'paintTile',None,P,I,I,I,I,I,I)(buffer,w,h,*(round(rectangle[k]) for k in ['x','y','width','height']))
        output.append({'key':spec['key'],'rectTwips':rectangle,'width':w,'height':h,'pixelFormat':'bgra' if mode==1 else 'rgba','alphaMode':'premultiplied','data':base64.b64encode(bytes(buffer)).decode()})
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
        view['actor']='human';result={'state':state(session,view),'streamId':stream,'ackSequence':sequence,'composing':bool(view.get('composition'))};result['state']['inputAck']={'streamId':stream,'sequence':sequence,'composing':result['composing']};view['inputStreams'][key]={'sequence':sequence,'signature':signature,'result':result}
        if len(view['inputStreams'])>64:view['inputStreams'].pop(next(iter(view['inputStreams'])))
        return result
    finally:session['operationActor']=None
def attach_kit_view(session,controller,args,identifier):
    view={'sessionId':session['sessionId'],'viewId':args['viewId'],'kitViewId':identifier,'controller':controller,'frame':controller.getFrame(),'disposed':False,'selectionEpoch':0,'layoutRevision':0,'renderGeneration':0,'eventSequence':0,'visible':False,'focused':False,'deviceScaleFactor':1,'bounds':{'x':0,'y':0,'width':0,'height':0},'viewportCss':{'width':0,'height':0},'inputStreams':{},'windows':{},'selectionRects':[],'partIndex':0,'actor':'human'}
    session['views'][view['viewId']]=view;session['activeViewId']=view['viewId'];activate(session,view)
    doc_call(session,'initializeForRendering',None,S)(b'{}');callback=kit_callback(session,view);view['kitCallback']=callback;doc_call(session,'registerCallback',None,CALLBACK,P)(callback,None)
    doc_call(session,'setAccessibilityState',None,I,B)(identifier,True)
    interceptor=ManagedInterceptor(view);view['managedInterceptor']=interceptor;view['frame'].registerDispatchProviderInterceptor(interceptor)
    listener=SelectionChanged(session,view);view['selectionListener']=listener;controller.addSelectionChangeListener(listener)
    if 'bounds' in args:layout_view(view,args)
    return view
def open_session(args):
    existing=next((s for s in sessions.values() if s['documentId']==args['documentId']),None)
    if existing:
        if existing['sessionId']!=args['sessionId']:fail('NATIVE_DUPLICATE_WRITER','此文档已经由另一 Office 会话编辑。')
        if args['viewId'] in existing['views']:view=existing['views'][args['viewId']];layout_view(view,args);return state(existing,view)
        previous=model_controllers(existing['doc']);identifier=doc_call(existing,'createView',I)();new=[c for c in model_controllers(existing['doc']) if all(c!=p for p in previous)]
        if len(new)!=1:fail('OFFICE_KIT_VIEW_UNAVAILABLE','Office 没有创建独立的同模型视图。')
        view=attach_kit_view(existing,new[0],args,identifier);return state(existing,view)
    format=args['format']
    if format not in ['docx','xlsx','pptx']:fail('NATIVE_FORMAT_UNSUPPORTED','Office 文档格式不受支持。')
    data=base64.b64decode(args['bytes'],validate=True)
    if len(data)>100*1024*1024:fail('NATIVE_DOCUMENT_LIMIT','Office 文档内容过大。')
    path=ROOT/(str(uuid.uuid4())+'.'+format);path.write_bytes(data)
    pointer=office_call('documentLoadWithOptions',P,S,S)(path.as_uri().encode(),b'MacroSecurityLevel=3,EnableMacrosExecution=false')
    if not pointer:fail('NATIVE_OPEN_FAILED','Office 内置引擎未打开文档。')
    provisional={'kit':pointer};expected_type={'docx':0,'xlsx':1,'pptx':2}[format]
    if doc_call(provisional,'getDocumentType',I)()!=expected_type:doc_call(provisional,'destroy',None)();fail('NATIVE_FORMAT_MISMATCH','Office 模型类型与文档身份不一致。')
    enum=desktop.getComponents().createEnumeration();matches=[]
    while enum.hasMoreElements():
        item=enum.nextElement()
        if getattr(item,'URL','')==path.as_uri():matches.append(item)
    if len(matches)!=1:doc_call(provisional,'destroy',None)();fail('OFFICE_KIT_MODEL_NOT_UNIQUE','OfficeKit 与原生对象模型未唯一关联。')
    doc=matches[0];session={'sessionId':args['sessionId'],'documentId':args['documentId'],'format':format,'revision':args['revision'],'engineRevision':0,'doc':doc,'kit':pointer,'unsavedContentChanges':bool(doc.isModified()),'views':{},'disposed':False,'path':path,'lastSnapshot':None,'mappingBytes':data,'operationActor':None,'actor':'human','requests':{}}
    sessions[session['sessionId']]=session;listener=Modified(session);session['modifyListener']=listener;doc.addModifyListener(listener)
    events=DocumentEvents(session);session['documentEvents']=events;doc.addDocumentEventListener(events)
    identifier=doc_call(session,'getView',I)();view=attach_kit_view(session,doc.getCurrentController(),args,identifier)
    return state(session,view)
def close_session(session,discard=False):
    if not discard and any(state(session,view)['pendingInput'] for view in session['views'].values()):fail('NATIVE_PENDING_INPUT','Office 文档仍有未提交的实际编辑输入。')
    if refresh_content_dirtiness(session) and not discard:fail('NATIVE_UNSAVED_CHANGES','请先保存或建立恢复快照，再关闭 Office 文档。')
    for view in list(session['views'].values()):
        for window in list(view['windows'].values()):doc_call(session,'postWindow',None,U,I,S)(window['id'],0,None)
    doc_call(session,'destroy',None)();session['disposed']=True;sessions.pop(session['sessionId'],None)
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
    activate(session,view);payload={name:{'type':'boolean' if type(value) is bool else 'long' if type(value) is int else 'double' if type(value) is float else 'string','value':value} for name,value in values.items()}
    doc_call(session,'postUnoCommand',None,S,S,B)(command.encode(),json.dumps(payload).encode() if payload else None,True)
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
    return {'state':state(session,view),'windowId':window['id'],'windowInstanceId':window['instanceId'],'generation':window['generation'],'tile':{'key':window['instanceId'],'rectTwips':{'x':0,'y':0,'width':window['width'],'height':window['height']},'width':width,'height':height,'pixelFormat':'bgra' if mode==1 else 'rgba','alphaMode':'premultiplied','data':base64.b64encode(bytes(buffer)).decode()}}
`;

const lifecycle = String.raw`
def surface_origin_css(session,view,visible):
    size=surface_size(session,view);scale=view.get('zoom',1)/15;viewport=view['viewportCss']
    # Match the DOM canvas origin: all formats centre horizontally; only
    # Impress centres a page that is shorter than its real safe viewport.
    return {'x':max(0,(viewport['width']-size['width']*scale)/2)-visible['x']*scale,'y':(max(0,(viewport['height']-size['height']*scale)/2) if session['format']=='pptx' else 0)-visible['y']*scale}

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
            point(action);visible=dict(view['visibleTwips']);size=surface_size(session,view);visible['x']=max(0,min(size['width']-visible['width'],visible['x']+action.get('deltaX',0)*15/view.get('zoom',1)));visible['y']=max(0,min(size['height']-visible['height'],visible['y']+action.get('deltaY',0)*15/view.get('zoom',1)));view['visibleTwips']=visible;view['layoutRevision']+=1
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
    key=args.get('requestId',identifier);signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest();prior=session['requests'].get(key)
    if prior:
        if prior['signature']!=signature:fail('IDEMPOTENCY_CONFLICT','Office 请求身份已用于另一操作。')
        return prior['result']
    expected(session,view,args);before=session['engineRevision'];session['operationActor']=args.get('actor','agent');manager=session['doc'].getUndoManager()
    try:
        if args.get('command'):
            values={p['name']:p['value'] for p in args.get('args',[])};status=yield from dispatch_with_history(session,view,args['command'],values,key)
        elif args.get('style'):
            apply_native_style(session,view,args['style'],args);status='applied' if session['engineRevision']!=before else 'no-change'
        else:
            manager.enterUndoContext('AgentViewer '+(args.get('operation',{}).get('kind') or ('替换选区' if args.get('replacement') else '编辑单元格')))
            try:
                if args.get('replacement'):replace_selected_text(session,view,args['replacement'],args)
                elif args.get('cell'):
                    cell=args['cell'];set_cell_content(session,checked_range(sheet_by_name(session,cell['sheetName']),cell['address']),cell['content'])
                elif args.get('operation'):execute_operation(session,view,args['operation'])
                else:fail('INVALID_NATIVE_OPERATION','Office 修改需要明确的实际目标。')
                status='applied' if session['engineRevision']!=before else 'no-change'
            finally:manager.leaveUndoContext()
        view['actor']=args.get('actor','agent');result={'status':status,'state':state(session,view)}
        if status=='applied':result['undoToken']=undo_state(session).get('token')
        session['requests'][key]={'signature':signature,'result':result}
        if len(session['requests'])>300:session['requests'].pop(next(iter(session['requests'])))
        return result
    finally:session['operationActor']=None
def handle_request(request):
    method=request.get('method');args=request.get('args',{});identifier=request.get('id')
    if method=='ping':return {'engineEpoch':epoch,'sessions':len(sessions),'surfaceKind':'tiled'}
    if method=='appearance':
        result=apply_native_appearance(args)
        for session in sessions.values():
            for view in session['views'].values():invalidate(session,view)
        return result
    if method=='open':
        result=open_session(args);yield;return state(sessions[args['sessionId']],sessions[args['sessionId']]['views'][args['viewId']])
    if method=='shutdown':
        for session in list(sessions.values()):close_session(session,args.get('discard',False))
        global quitting;quitting=True;return {'closed':True}
    session=session_for(args);view=view_for(session,args)
    if method in ['state','surfaceState','office-surface-state']:return state(session,view)
    if method in ['layout','surfaceLayout','office-surface-layout']:layout_view(view,args);yield;return state(session,view)
    if method in ['surfaceTiles','office-surface-tiles']:return tiles(session,view,args)
    if method in ['surfaceInput','office-surface-input']:return (yield from input_request(session,view,args))
    if method in ['surfaceWindowPaint','office-surface-window-paint']:return paint_window(session,view,args)
    if method in ['surfaceWindowInput','office-surface-window-input']:return (yield from input_request(session,view,args,window_for(session,view,args)))
    if method in ['surfaceWindowClose','office-surface-window-close']:
        window=window_for(session,view,args);doc_call(session,'postWindow',None,U,I,S)(window['id'],0,None);yield;return state(session,view)
    if method in ['surfaceWindowClipboard','office-surface-window-clipboard']:
        window_for(session,view,args);fail('OFFICE_WINDOW_CLIPBOARD_UNAVAILABLE','当前 OfficeKit 只提供文档视图剪贴板，不能将其当作独立窗口内容。')
    if method=='snapshot':return snapshot(session,view)
    if method=='exportCopy':expected(session,view,args);return snapshot(session,view,args['format'])
    if method=='capture':return capture(session,view,args.get('rect'))
    if method=='commands':return commands(session,view)
    if method=='commandStatus':return command_status(view,args['command'])
    if method=='query':return query(session,view,args['target'])
    if method=='execute':return (yield from execute_request(session,view,args,identifier))
    if method=='dispatch':
        expected(session,view,args);session['operationActor']=args.get('actor','agent')
        try:
            status=yield from dispatch_with_history(session,view,args['command'],args.get('args',{}),identifier)
            return {'status':status,'state':state(session,view)}
        finally:session['operationActor']=None
    if method=='input':
        key='input:'+args['idempotencyKey'];signature=hashlib.sha256(json.dumps(args,sort_keys=True,ensure_ascii=False).encode()).hexdigest();prior=session['requests'].get(key)
        if prior:
            if prior['signature']!=signature:fail('IDEMPOTENCY_CONFLICT','Office 输入身份已用于另一操作。')
            return prior['result']
        result=yield from native_input(session,view,args);session['requests'][key]={'signature':signature,'result':result};return result
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
        if len(session['views'])==1:fail('NATIVE_LAST_VIEW','请通过文档会话关闭最后一个视图。')
        doc_call(session,'destroyView',None,I)(view['kitViewId']);view['disposed']=True;session['views'].pop(view['viewId']);session['activeViewId']=next(iter(session['views']));return None
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
            emit({'id':self.request.get('id'),'ok':True,'result':completed.value});self.active=None;self.request=None
            if quitting:shutdown_event.set();return
        except BaseException as error:
            message=str(error);code,separator,detail=message.partition('|');emit({'id':self.request.get('id'),'ok':False,'error':{'code':code if separator else 'NATIVE_ENGINE_ERROR','message':detail if separator else 'Office 内置引擎操作失败。'}});self.active=None;self.request=None
        finally:self.executing=False
        if not self.resumeAfter and (self.active is not None or not request_queue.empty()):async_service.addCallback(self,None)
def receive_rpc():
    try:
        with rpc.makefile('rb') as reader:
            while not quitting:
                line=reader.readline(150*1024*1024+1)
                if not line:break
                if len(line)>150*1024*1024:emit({'type':'diagnostic','code':'NATIVE_PROTOCOL_LIMIT'});break
                value=json.loads(line)
                if not isinstance(value,dict) or not isinstance(value.get('method'),str):fail('NATIVE_PROTOCOL_ERROR','Office 请求结构无效。')
                request_queue.put(value);async_service.addCallback(pump,None)
    except:emit({'type':'diagnostic','code':'OFFICE_KIT_CONNECTION_LOST'})
    finally:
        if not quitting:shutdown_event.set()
shutdown_event=threading.Event()
try:
    version=json.loads(kit_string(office_call('getVersionInfo',P)()))
    if version.get('BuildId')!='bf6ef2662401c7d6dce671ab4deb26ee0af3a7c1':fail('OFFICE_KIT_VERSION_MISMATCH','Office 引擎构建版本未通过接口验证。')
    office_call('setOptionalFeatures',None,C.c_ulonglong)(1<<2)
    ctx=uno.getComponentContext();sm=ctx.ServiceManager;desktop=sm.createInstanceWithContext('com.sun.star.frame.Desktop',ctx);dispatcher=sm.createInstanceWithContext('com.sun.star.frame.DispatchHelper',ctx);transformer=sm.createInstanceWithContext('com.sun.star.util.URLTransformer',ctx);async_service=sm.createInstanceWithContext('com.sun.star.awt.AsyncCallback',ctx)
    verify_shared_globals();pump=RpcPump()
    request_queue.put({'id':'initial-appearance','method':'appearance','args':config.get('appearance',{'theme':'light','canvasColor':0xf7f5f2})});async_service.addCallback(pump,None)
    emit({'type':'ready','engineEpoch':epoch,'engine':'LibreOfficeKit','surfaceKind':'tiled','workerPid':os.getpid(),'officeClassSize':abi_table(office,OfficeTable).nSize,'documentClassSize':C.sizeof(DocumentTable)})
    threading.Thread(target=receive_rpc,daemon=True).start();shutdown_event.wait()
except BaseException as error:
    emit({'type':'diagnostic','code':'OFFICE_KIT_STARTUP_FAILED'});emit({'type':'startup-error','message':str(error).partition('|')[2] or 'Office 内置引擎启动失败。'})
finally:
    if rpc:
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
  + '\n' + officeKitAbiSource + '\n' + surface + '\n' + inputAndModel + '\n' + lifecycle;
