#include "DesktopGlass.h"
#include <string>
#include <wtsapi32.h>

// Interactive example: C starts capture after the user chooses to do so.
// It is not executed by CTest. Foreground/input belong to this host, not the DLL.
namespace {
DG_Handle glass=nullptr;DG_Parameters parameters{};bool capturing=false,dragging=false,sessionLocked=false;
HMONITOR chosenMonitor=nullptr;ULONGLONG retryAt=0;
POINT grip{};
void ReleaseGraphics(){if(glass){DG_Destroy(glass);glass=nullptr;}}
void Check(HWND window,HRESULT result){
    if(SUCCEEDED(result))return;
    char message[2048]{};DG_LastError(message,sizeof(message));
    std::wstring title=L"DesktopGlass error "+std::to_wstring(static_cast<unsigned long>(result))+L"; press C to choose again";
    SetWindowTextW(window,title.c_str());ReleaseGraphics();retryAt=GetTickCount64()+500;
    // A source explicitly closed outside session recovery needs a new choice.
    if(result==RO_E_CLOSED)capturing=false;
    OutputDebugStringA(message);
}
LRESULT CALLBACK WindowProc(HWND window,UINT message,WPARAM wParam,LPARAM lParam){
    switch(message){
    case WM_CREATE:
        DG_DefaultParameters(&parameters);
        if(!WTSRegisterSessionNotification(window,NOTIFY_FOR_THIS_SESSION))return -1;
        SetTimer(window,1,8,nullptr);return 0;
    case WM_KEYDOWN:
        if(wParam=='C'){
            ReleaseGraphics();chosenMonitor=MonitorFromWindow(window,MONITOR_DEFAULTTONEAREST);capturing=true;retryAt=0;
        }else if(wParam==VK_ESCAPE)DestroyWindow(window);
        else if(wParam=='H'){capturing=false;ReleaseGraphics();}
        else if(wParam=='S'){capturing=chosenMonitor!=nullptr;retryAt=0;}
        return 0;
    case WM_WTSSESSION_CHANGE:
        if(wParam==WTS_SESSION_LOCK){sessionLocked=true;ReleaseGraphics();}
        else if(wParam==WTS_SESSION_UNLOCK){sessionLocked=false;retryAt=0;}
        return 0;
    case WM_LBUTTONDOWN:{POINT cursor{};RECT bounds{};GetCursorPos(&cursor);GetWindowRect(window,&bounds);
        grip={cursor.x-bounds.left,cursor.y-bounds.top};dragging=true;SetCapture(window);return 0;}
    case WM_MOUSEMOVE:
        if(dragging){POINT cursor{};GetCursorPos(&cursor);
            SetWindowPos(window,nullptr,cursor.x-grip.x,cursor.y-grip.y,0,0,SWP_NOSIZE|SWP_NOZORDER|SWP_NOACTIVATE);}
        return 0;
    case WM_LBUTTONUP:dragging=false;ReleaseCapture();return 0;
    case WM_CAPTURECHANGED:dragging=false;return 0;
    case WM_TIMER:
        if(capturing&&!sessionLocked){
            if(GetTickCount64()<retryAt)return 0;
            if(!glass){
                HRESULT hr=DG_Create(window,280,112,&glass);Check(window,hr);if(FAILED(hr))return 0;
                hr=DG_SelectMonitor(glass,chosenMonitor,FALSE,TRUE);Check(window,hr);if(FAILED(hr))return 0;
                SetWindowTextW(window,L"DesktopGlass - live; drag the client area");
            }
            RECT bounds{};POINT cursor{};GetWindowRect(window,&bounds);GetCursorPos(&cursor);
            parameters.dpi_scale=GetDpiForWindow(window)/96.f;
            parameters.pointer_screen_x_px=float(cursor.x);parameters.pointer_screen_y_px=float(cursor.y);parameters.pointer_presence=1;
            Check(window,DG_Render(glass,bounds.right+12,bounds.top,&parameters));
            if(glass)Check(window,DG_Present(glass));
        }
        return 0;
    case WM_PAINT:{
        PAINTSTRUCT paint{};HDC dc=BeginPaint(window,&paint);RECT area{};GetClientRect(window,&area);
        SetBkMode(dc,TRANSPARENT);
        DrawTextW(dc,L"C: capture this display\nDrag here: move the glass beside this window\nH / S: hide / resume   Esc: close",-1,&area,DT_LEFT|DT_TOP);
        EndPaint(window,&paint);return 0;
    }
    case WM_DESTROY:
        KillTimer(window,1);WTSUnRegisterSessionNotification(window);ReleaseGraphics();PostQuitMessage(0);return 0;
    }
    return DefWindowProcW(window,message,wParam,lParam);
}
}
int WINAPI wWinMain(HINSTANCE instance,HINSTANCE,PWSTR,int show){
    SetProcessDpiAwarenessContext(DPI_AWARENESS_CONTEXT_PER_MONITOR_AWARE_V2);
    WNDCLASSW wc{};wc.lpfnWndProc=WindowProc;wc.hInstance=instance;wc.lpszClassName=L"DesktopGlassExample";
    wc.hCursor=LoadCursorW(nullptr,IDC_ARROW);wc.hbrBackground=reinterpret_cast<HBRUSH>(COLOR_WINDOW+1);
    if(!RegisterClassW(&wc))return 1;
    HWND window=CreateWindowExW(WS_EX_TOPMOST,wc.lpszClassName,L"DesktopGlass - press C to start",
        WS_OVERLAPPEDWINDOW,180,220,430,190,nullptr,nullptr,instance,nullptr);
    if(!window)return 2;ShowWindow(window,show);
    MSG message{};while(GetMessageW(&message,nullptr,0,0)>0){TranslateMessage(&message);DispatchMessageW(&message);}return int(message.wParam);
}
