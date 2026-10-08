// Mouse buttons and the Control key, read the way overlay.rs reads them on Windows:
// polled from the overlay thread. The click counters catch a click that starts and
// ends between two polls (Windows' GetAsyncKeyState low bit does the same there).

const COMBINED_SESSION: i32 = 0; // kCGEventSourceStateCombinedSessionState
const LEFT_BUTTON: u32 = 0; // kCGMouseButtonLeft
const RIGHT_BUTTON: u32 = 1; // kCGMouseButtonRight
const LEFT_DOWN: u32 = 1; // kCGEventLeftMouseDown
const RIGHT_DOWN: u32 = 3; // kCGEventRightMouseDown
const CONTROL_MASK: u64 = 1 << 18; // kCGEventFlagMaskControl

#[link(name = "CoreGraphics", kind = "framework")]
extern "C" {
    fn CGEventSourceButtonState(state: i32, button: u32) -> bool;
    fn CGEventSourceFlagsState(state: i32) -> u64;
    fn CGEventSourceCounterForEventType(state: i32, event_type: u32) -> u32;
}

pub fn control_down() -> bool {
    unsafe { CGEventSourceFlagsState(COMBINED_SESSION) & CONTROL_MASK != 0 }
}

/// Mouse-down counts at the last poll.
pub struct Clicks {
    left: u32,
    right: u32,
}

impl Clicks {
    pub fn new() -> Self {
        unsafe {
            Self {
                left: CGEventSourceCounterForEventType(COMBINED_SESSION, LEFT_DOWN),
                right: CGEventSourceCounterForEventType(COMBINED_SESSION, RIGHT_DOWN),
            }
        }
    }

    /// ((left held, left pressed since last poll), (right held, right pressed since last poll)).
    pub fn poll(&mut self) -> ((bool, bool), (bool, bool)) {
        unsafe {
            let left = CGEventSourceCounterForEventType(COMBINED_SESSION, LEFT_DOWN);
            let right = CGEventSourceCounterForEventType(COMBINED_SESSION, RIGHT_DOWN);
            let hits = (left != self.left, right != self.right);
            self.left = left;
            self.right = right;
            (
                (CGEventSourceButtonState(COMBINED_SESSION, LEFT_BUTTON), hits.0),
                (CGEventSourceButtonState(COMBINED_SESSION, RIGHT_BUTTON), hits.1),
            )
        }
    }
}
