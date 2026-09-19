# Jev guides ordered room-boundary repair

Room boundaries will be resolved as ordered traversals over Wall Elements and Opening Elements. Geometry code may enumerate reachable next edges, calculate repair consequences, and validate closure, but Jev chooses the next edge, repair action, and final enclosure. Door, window, and drafting-gap repairs are recorded as Virtual Boundary Edges and never become physical walls. This preserves Jev as relationship authority while keeping every repair geometrically testable and reviewable.
