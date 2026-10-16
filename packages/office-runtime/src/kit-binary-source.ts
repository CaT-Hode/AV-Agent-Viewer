/** Private Kit worker transport. Native paint/UNO work must stay outside output_lock. */
export const officeKitBinarySource = String.raw`
KIT_BINARY_MAGIC=b'AVKIT02\0'
KIT_BINARY_VERSION=2
KIT_JSON_UNITS_MAX=160*1024*1024
KIT_JSON_BYTES_MAX=3*KIT_JSON_UNITS_MAX
KIT_RAW_BYTES_MAX=64*1024*1024
KIT_ATTACHMENT_MAX=96
KIT_REQUEST_BYTES_MAX=150*1024*1024
KIT_ASTRAL_PATTERN=re.compile(r'[\U00010000-\U0010ffff]')
kit_transport_mode='pending'
kit_transport_failed=False
kit_rpc_reader=None
# DLL initialization emits diagnostics before the lifecycle source is loaded.
# Failure must have an already existing, single exit signal at that point.
shutdown_event=threading.Event()

def kit_transport_fail():
    global kit_transport_failed,kit_transport_mode,quitting
    with output_lock:
        if kit_transport_failed:return
        kit_transport_failed=True;kit_transport_mode='failed';quitting=True
        shutdown_event.set()
        # Never log by recursively calling emit on the damaged transport.
        if rpc is not None:
            try:rpc.shutdown(socket.SHUT_RDWR)
            except:pass
            try:rpc.close()
            except:pass

def kit_utf16_units(text):
    # Python len counts Unicode scalars; the legacy Node reader counts UTF-16
    # units. The C regex only visits astral matches, without making another
    # full UTF-16 copy of a large base64 document/capture control payload.
    return len(text)+sum(1 for unused in KIT_ASTRAL_PATTERN.finditer(text))

def kit_json_bytes(value):
    text=json.dumps(value,ensure_ascii=False,separators=(',',':'),allow_nan=False)
    units=kit_utf16_units(text)
    if units>KIT_JSON_UNITS_MAX:raise ValueError('OFFICE_KIT_JSON_LIMIT')
    encoded=text.encode('utf-8','strict')
    if len(encoded)>KIT_JSON_BYTES_MAX:raise ValueError('OFFICE_KIT_JSON_BYTES_LIMIT')
    return encoded

def kit_checked_tile(tile,maximum):
    if not isinstance(tile,dict):raise ValueError('OFFICE_KIT_TILE_SHAPE')
    width=tile.get('width');height=tile.get('height');key=tile.get('key');data=tile.get('data')
    if type(width) is not int or type(height) is not int or not 1<=width<=maximum or not 1<=height<=maximum:raise ValueError('OFFICE_KIT_TILE_SIZE')
    if not isinstance(key,str) or not 1<=kit_utf16_units(key)<=128 or tile.get('pixelFormat') not in ['rgba','bgra'] or 'alphaMode' in tile and tile['alphaMode'] not in ['straight','premultiplied']:raise ValueError('OFFICE_KIT_TILE_METADATA')
    rectangle=tile.get('rectTwips')
    if not isinstance(rectangle,dict) or any(type(rectangle.get(name)) not in [int,float] or not math.isfinite(rectangle[name]) for name in ['x','y','width','height']) or rectangle['width']<=0 or rectangle['height']<=0:raise ValueError('OFFICE_KIT_TILE_RECTANGLE')
    # Paint owns immutable exact bytes. Do not retain a mutable ctypes buffer,
    # copy a whole frame, or base64-decode a string into the new transport.
    if not isinstance(data,bytes) or len(data)!=width*height*4:raise ValueError('OFFICE_KIT_TILE_BYTES')
    metadata={name:value for name,value in tile.items() if name!='data'}
    return metadata,data

def kit_binary_frame(value,method=None):
    if not isinstance(value,dict):raise ValueError('OFFICE_KIT_MESSAGE_SHAPE')
    message=value;attachments=[];bodies=[]
    if value.get('ok') is True and method in ['surfaceTiles','office-surface-tiles','surfaceWindowPaint','office-surface-window-paint']:
        if 'type' in value:raise ValueError('OFFICE_KIT_TILE_REPLY_TYPE')
        if not isinstance(value.get('id'),str) or not value['id']:raise ValueError('OFFICE_KIT_TILE_ID')
        result=value.get('result')
        if not isinstance(result,dict):raise ValueError('OFFICE_KIT_TILE_RESULT')
        result=dict(result);message=dict(value);message['result']=result
        if method in ['surfaceTiles','office-surface-tiles']:
            tiles=result.get('tiles')
            if not isinstance(tiles,list) or len(tiles)>KIT_ATTACHMENT_MAX:raise ValueError('OFFICE_KIT_TILE_COUNT')
            output=[]
            for index,tile in enumerate(tiles):
                metadata,data=kit_checked_tile(tile,2048);output.append(metadata);bodies.append(data);attachments.append({'tileIndex':index,'byteLength':len(data)})
            result['tiles']=output
        else:
            metadata,data=kit_checked_tile(result.get('tile'),4096);result['tile']=metadata;bodies.append(data);attachments.append({'tileIndex':0,'byteLength':len(data)})
    total=sum(len(body) for body in bodies)
    if total>KIT_RAW_BYTES_MAX:raise ValueError('OFFICE_KIT_RAW_LIMIT')
    metadata=kit_json_bytes({'message':message,'attachments':attachments})
    header=struct.pack('>8sHHIII',KIT_BINARY_MAGIC,KIT_BINARY_VERSION,0,len(metadata),len(attachments),total)
    return header,metadata,bodies

def kit_emit(value,method=None):
    # Preparing JSON and validating immutable pixel bodies happens before the
    # lock. The shared RLock then covers every sendall of this one whole frame,
    # including when sendall releases the GIL to another native callback thread.
    while True:
        mode=kit_transport_mode
        if kit_transport_failed or mode in ['failed','negotiating']:return False
        try:
            if mode=='binary-v2':header,metadata,bodies=kit_binary_frame(value,method)
            elif mode in ['pending','legacy']:
                if mode=='pending' and value.get('type') not in ['diagnostic','startup-error']:raise ValueError('OFFICE_KIT_PREAUTH_MESSAGE')
                metadata=kit_json_bytes(value);header=None;bodies=[]
            else:raise ValueError('OFFICE_KIT_TRANSPORT_MODE')
            with output_lock:
                if kit_transport_failed:return False
                if mode!=kit_transport_mode:continue
                if mode=='binary-v2':
                    rpc.sendall(header);rpc.sendall(metadata)
                    for body in bodies:rpc.sendall(body)
                else:sys.stdout.write(metadata.decode('utf-8')+'\n');sys.stdout.flush()
                return True
        except BaseException:
            kit_transport_fail();return False

def kit_emit_reply(request,result):
    return kit_emit({'id':request.get('id'),'ok':True,'result':result},request.get('method'))

def kit_pixel_data(buffer):
    data=bytes(buffer)
    return data if kit_transport_mode=='binary-v2' else base64.b64encode(data).decode('ascii')

def kit_negotiate_transport(connection,token):
    global rpc,kit_rpc_reader,kit_transport_mode
    if kit_transport_mode!='pending' or kit_transport_failed:raise RuntimeError('OFFICE_KIT_NEGOTIATION_STATE|Office 私有连接状态无效。')
    rpc=connection
    try:
        # One BufferedReader owns both ACK and all later JSONL requests. Reading
        # ACK through another file object could discard its prefetched tail.
        connection.settimeout(15);kit_rpc_reader=connection.makefile('rb')
        with output_lock:
            kit_transport_mode='negotiating'
            connection.sendall((json.dumps({'type':'auth','token':token,'protocolVersion':2,'capabilities':['binary-tiles']},separators=(',',':'))+'\n').encode('utf-8'))
        line=kit_rpc_reader.readline(4097)
        if not line.endswith(b'\n') or len(line)>4096:raise ValueError('OFFICE_KIT_ACK_LIMIT')
        acknowledgement=json.loads(line.decode('utf-8','strict'))
        if not isinstance(acknowledgement,dict) or set(acknowledgement)!=set(['type','protocolVersion']) or acknowledgement.get('type')!='auth-ack' or type(acknowledgement.get('protocolVersion')) is not int or acknowledgement['protocolVersion']!=2:raise ValueError('OFFICE_KIT_ACK_INVALID')
        connection.settimeout(None)
        with output_lock:kit_transport_mode='binary-v2'
        return kit_rpc_reader
    except BaseException:
        kit_transport_fail()
        raise RuntimeError('OFFICE_KIT_NEGOTIATION_FAILED|Office 私有连接未确认二进制协议。') from None
`;
